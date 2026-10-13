import { PRIVACY_POLICY_SECTIONS, PRIVACY_POLICY_EFFECTIVE_DATE } from "./privacyPolicy";
export { asset } from "@/config";
export const siteConfig = {
 repositoryUrl: "https://github.com/your-org/citely",
 licenseText: "See the project repository for license information.",
 privacyVersion: "1.0",
 privacyEffectiveDate: PRIVACY_POLICY_EFFECTIVE_DATE,
 privacySections: PRIVACY_POLICY_SECTIONS.map(s => ({heading:s.heading,body:s.body.join("\n\n")})),
 acceptedFileTypes: ".pdf,.txt,.md,.csv,.json,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp",
};
