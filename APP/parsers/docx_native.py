"""Native Word body reading without flattening document XML to binary text."""
import io
import zipfile
from xml.etree import ElementTree as ET
from langchain_core.documents import Document
from APP.parsers.base import DocumentParser
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
M='{http://schemas.openxmlformats.org/officeDocument/2006/math}'

class LocalDocxParser(DocumentParser):
    name='local-docx'
    structured=True
    extensions=('.docx',)
    def parse(self,raw_bytes,filename):
        with zipfile.ZipFile(io.BytesIO(raw_bytes)) as archive:
            if sum(x.file_size for x in archive.infolist())>100*1024*1024: raise ValueError('Expanded Word document too large')
            root=ET.fromstring(archive.read('word/document.xml'))
        docs=[]
        body=root.find(W+'body')
        for i,block in enumerate(body if body is not None else []):
            if block.tag==W+'tbl':
                rows=[]
                for r,row in enumerate(block.findall(W+'tr'),1):
                    cells=[''.join(t.text or '' for t in cell.iter(W+'t')) for cell in row.findall(W+'tc')]
                    rows.append(f'Row {r}: '+' | '.join(cells))
                text='\n'.join(rows)
            else:
                # Do not concatenate OMML symbols and call that an exact equation.
                text=''.join(t.text or '' for t in block.iter(W+'t'))
            if text.strip(): docs.append(Document(page_content=text,metadata={'source':filename,'page':1,'body_block':i}))
        return docs
