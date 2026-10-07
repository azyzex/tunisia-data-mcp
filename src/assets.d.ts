// PNG files are bundled as binary data (see "rules" in wrangler.jsonc).
declare module "*.png" {
	const data: ArrayBuffer;
	export default data;
}
