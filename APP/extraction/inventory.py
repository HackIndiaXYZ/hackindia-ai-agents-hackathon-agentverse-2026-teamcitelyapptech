"""Local visual inventory. Every occurrence survives content deduplication."""
from __future__ import annotations
import hashlib
import io
from dataclasses import dataclass, field
from pathlib import Path
from langchain_core.documents import Document

@dataclass
class Visual:
    location: dict
    data: bytes
    mode: str = 'read'
    error: str | None = None
    key: str | None = None      # identifies the picture's content: the same picture in many places is read once

@dataclass
class Inventory:
    pages: int
    visuals: list[Visual] = field(default_factory=list)


def png(data):
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        if im.width*im.height > 30_000_000: raise ValueError('Image exceeds 30 megapixels')
        out=io.BytesIO(); ImageOps.exif_transpose(im).convert('RGB').save(out,format='PNG')
        return out.getvalue()


MIN_PICTURE_PIXELS = 100        # smaller than about 10x10 is a spacer, never content; anything larger is kept


def _matrix_multiply(m, n):
    """PDF row-vector convention: the result applies m first, then n."""
    return [m[0]*n[0] + m[1]*n[2], m[0]*n[1] + m[1]*n[3], m[2]*n[0] + m[3]*n[2], m[2]*n[1] + m[3]*n[3],
            m[4]*n[0] + m[5]*n[2] + n[4], m[4]*n[1] + m[5]*n[3] + n[5]]


def _pdf_placements(page) -> dict | None:
    """Where each picture is drawn on the page: {xobject name: [box, ...]}, a box being
    [left, top, width, height] as fractions of the page. An empty dict means the page was
    read and draws no picture; None means its drawing instructions could not be read, so
    the caller cannot tell what is drawn."""
    from pypdf.generic import ContentStream
    media = page.mediabox
    left, bottom, width, height = float(media.left), float(media.bottom), float(media.width), float(media.height)
    found: dict[str, list] = {}

    def walk(stream, resources, ctm, depth):
        operations = ContentStream(stream, page.pdf).operations
        saved = []
        for operands, operator in operations:
            if operator == b'q':
                saved.append(ctm)
            elif operator == b'Q':
                ctm = saved.pop() if saved else ctm
            elif operator == b'cm' and len(operands) == 6:
                ctm = _matrix_multiply([float(x) for x in operands], ctm)
            elif operator == b'Do' and operands:
                try:
                    xobject = resources['/XObject'][operands[0]].get_object()
                    kind = xobject.get('/Subtype')
                except Exception:
                    continue
                if kind == '/Image':
                    xs = [ctm[0]*cx + ctm[2]*cy + ctm[4] for cx in (0, 1) for cy in (0, 1)]
                    ys = [ctm[1]*cx + ctm[3]*cy + ctm[5] for cx in (0, 1) for cy in (0, 1)]
                    # Clip to the page: a picture drawn larger than the page, or shifted off it, is
                    # still only as big as the part of it the reader can see.
                    clip = lambda v: min(1.0, max(0.0, v))
                    l, r = clip((min(xs) - left) / width), clip((max(xs) - left) / width)
                    t, b = clip(1 - (max(ys) - bottom) / height), clip(1 - (min(ys) - bottom) / height)
                    found.setdefault(str(operands[0]).lstrip('/'), []).append([round(l, 4), round(t, 4), round(r - l, 4), round(b - t, 4)])
                elif kind == '/Form' and depth < 4:
                    matrix = [float(x) for x in xobject.get('/Matrix', [1, 0, 0, 1, 0, 0])]
                    walk(xobject, xobject.get('/Resources', resources), _matrix_multiply(matrix, ctm), depth + 1)

    try:
        contents = page.get_contents()
        if contents is not None:
            walk(contents, page['/Resources'], [1, 0, 0, 1, 0, 0], 0)
    except Exception:
        return None
    return found


def _whole_page_visual(page, number: int, text_present: bool, count: int) -> Visual:
    """The fallback when a page's pictures cannot be taken out one by one: the page itself,
    as a one-page PDF, which keeps its composition and lets the reader see all its pixels."""
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_page(page)
    buffer = io.BytesIO()
    writer.write(buffer)
    return Visual({'format': 'pdf', 'page': number, 'box': [0, 0, 1, 1], 'native_text_present': text_present, 'image_count': count}, buffer.getvalue())


def _inspect_pdf(raw: bytes) -> Inventory:
    """The pictures of a PDF, one by one, each read once however often it appears.

    Only the pictures are sent to be read: the page's own text is already extracted for
    free, and paying again to read it was most of the cost. A picture repeated on many
    pages (a logo in every header) has one content key, so it is read once, while every
    place it appears keeps its own location. A page whose pictures cannot be taken out
    is sent whole instead, so nothing is lost for want of a decoder."""
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(raw))
    inventory = Inventory(len(reader.pages))
    pictures: dict[str, bytes] = {}                      # content key -> the PNG that is sent
    for number, page in enumerate(reader.pages, 1):
        try:
            images = list(page.images)
        except Exception:
            images = None
        if images is None:
            inventory.visuals.append(_whole_page_visual(page, number, False, 0))
            continue
        if not images:
            continue
        text_present = bool((page.extract_text() or '').strip())
        placements = _pdf_placements(page)
        if placements is not None:
            # A page's image list holds every picture in its RESOURCES, whether or not the page
            # draws it (many exporters list them all on every page). Only drawn ones count.
            # (When the drawing instructions cannot be read, every listed picture is read.)
            images = [im for im in images if im.name.rsplit('.', 1)[0].split('/')[-1] in placements]
        placements = placements or {}
        for image in images:
            try:
                width, height = image.image.size
            except Exception:
                inventory.visuals.append(Visual({'format': 'pdf', 'page': number, 'box': [0, 0, 1, 1], 'native_text_present': text_present},
                                                b'', error='Rendering required for unsupported image encoding'))
                continue
            if width * height < MIN_PICTURE_PIXELS:
                continue
            key = hashlib.sha256(image.data).hexdigest()
            error = None
            if key not in pictures:
                try:
                    pictures[key] = png(image.data)
                except Exception as exc:
                    pictures[key] = b''
                    error = str(exc) or 'Rendering required for unsupported image encoding'
            elif not pictures[key]:
                error = 'Rendering required for unsupported image encoding'
            boxes = placements.get(image.name.rsplit('.', 1)[0].split('/')[-1]) or [[0, 0, 1, 1]]
            for box in boxes:
                inventory.visuals.append(Visual({'format': 'pdf', 'page': number, 'box': box, 'native_text_present': text_present,
                                                 'size': [width, height], 'image': key[:12]}, pictures[key], error=error, key=key))
    return inventory


def inspect(raw: bytes, filename: str) -> Inventory:
    suffix=Path(filename).suffix.lower()
    if suffix=='.pptx':
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE
        deck=Presentation(io.BytesIO(raw)); inv=Inventory(len(deck.slides))
        def walk(shapes, page, grouped=False):
            for shape in shapes:
                if shape.shape_type==MSO_SHAPE_TYPE.GROUP:
                    walk(shape.shapes,page,True); continue
                loc={'format':'pptx','page':page,'slide_index':page-1,'shape_id':int(shape.shape_id),
                     'box':[shape.left/deck.slide_width,shape.top/deck.slide_height,shape.width/deck.slide_width,shape.height/deck.slide_height]}
                if shape.shape_type==MSO_SHAPE_TYPE.PICTURE:
                    reason='Rendering required for grouped, cropped or rotated picture' if grouped or shape.rotation or any(getattr(shape,k,0) for k in ('crop_left','crop_right','crop_top','crop_bottom')) else None
                    # Overlaid text/graphics can change the meaning of the asset.
                    # Text over a picture is already read natively; only overlaid
                    # drawings could change what the picture means. So the raw
                    # picture is still read, and the overlap is recorded so the
                    # answer can say its text comes from the picture alone.
                    for other in shapes:
                        if other.shape_id==shape.shape_id: continue
                        if other.left < shape.left+shape.width and other.left+other.width > shape.left and other.top < shape.top+shape.height and other.top+other.height > shape.top:
                            loc['overlaid']=True; break
                    try: data=png(shape.image.blob)
                    except Exception: data=shape.image.blob; reason='Rendering required for unsupported image encoding'
                    inv.visuals.append(Visual(loc,data,error=reason))
                elif shape._element.xpath('.//a:graphicData[@uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"]'):
                    inv.visuals.append(Visual(loc,b'',error='Rendering required for SmartArt'))
        for i,slide in enumerate(deck.slides,1): walk(slide.shapes,i)
        return inv
    if suffix=='.pdf':
        return _inspect_pdf(raw)
    if suffix=='.xlsx':
        import openpyxl
        wb=openpyxl.load_workbook(io.BytesIO(raw),data_only=False)
        inv=Inventory(len(wb.sheetnames))
        try:
            for i,ws in enumerate(wb.worksheets,1):
                for n,im in enumerate(ws._images):
                    anchor=getattr(im.anchor,'_from',None)
                    loc={'format':'xlsx','page':i,'sheet_name':ws.title,'sheet_index':wb.sheetnames.index(ws.title),'picture':n}
                    if anchor:
                        from openpyxl.utils import get_column_letter
                        loc['range']=f'{get_column_letter(anchor.col+1)}{anchor.row+1}'
                    inv.visuals.append(Visual(loc,png(im._data())))
        finally: wb.close()
        return inv
    if suffix=='.docx':
        import zipfile
        from xml.etree import ElementTree as ET
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            rels={r.attrib['Id']:r.attrib.get('Target','') for r in ET.fromstring(z.read('word/_rels/document.xml.rels')) if r.attrib.get('TargetMode')!='External'}
            root=ET.fromstring(z.read('word/document.xml'))
            inv=Inventory(1)
            ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
            for i,blip in enumerate(root.findall('.//a:blip',ns)):
                target=rels.get(blip.get('{'+ns['r']+'}embed'),'')
                if not target.startswith('media/'): continue
                try: data=png(z.read('word/'+target)); error=None
                except Exception: data=b''; error='Rendering required for unsupported Word image'
                inv.visuals.append(Visual({'format':'docx','page':1,'picture':i},data,error=error))
            return inv
    if suffix in ('.png','.jpg','.jpeg','.webp','.bmp','.tiff'):
        return Inventory(1,[Visual({'format':'image','page':1,'box':[0,0,1,1]},png(raw))])
    return Inventory(0)


def persist(owner, document, raw, filename, inventory, native_chunks):
    from APP.extraction import store
    from APP.rag.vector_store import document_index_dir
    import os
    version=store.register(owner,document,raw,inventory.pages)
    root=document_index_dir(owner,document)/'evidence'; root.mkdir(parents=True,exist_ok=True)
    # Keep immutable native snapshots. Their existing page offsets stay valid.
    for chunk in native_chunks:
        location={'page':chunk.metadata.get('page',1),'native_anchor':chunk.metadata.get('native_anchor'),
                  'start':chunk.metadata.get('page_char_start'),'end':chunk.metadata.get('page_char_end')}
        rid=store.add_region(document,version,location,state='done')
        eid=store.add_record(rid,chunk.page_content,provenance='native',extractor='native:1')
        chunk.metadata.update(region_id=rid,evidence_record_id=eid,provenance='native')
    # The limit counts DISTINCT pictures: a logo repeated on every page is read once, so its
    # repeats cost nothing and never count against it. Sized for a long deck of slide images.
    limit=int(os.getenv('EXTRACTION_MAX_IMAGES','150'))
    accepted=set()
    for visual in inventory.visuals:
        digest=visual.key or hashlib.sha256(visual.data).hexdigest()
        suffix='.pdf' if visual.data.startswith(b'%PDF') else '.png'
        path=root/(digest+suffix)
        if not path.exists() and visual.data: path.write_bytes(visual.data)
        over_limit = digest not in accepted and len(accepted) >= limit
        error=visual.error or ('Image limit reached; this visual was not processed' if over_limit else None)
        if not error: accepted.add(digest)
        store.add_region(document,version,visual.location,asset_hash=digest,asset_path=str(path),
                         state='unsupported' if error else 'queued',error=error,mode=visual.mode)
