import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPdfTools } from "./src/tools";

export default function (pi: ExtensionAPI) {
	registerPdfTools(pi);
}
