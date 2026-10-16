# Gate: WXT Manifest V3 Configuration & Production Build

## Condition
`wxt.config.ts` declares an MV3 manifest with permissions `tabs`, `activeTab`, `storage` and host permissions for `https://gemini.google.com/*`; `wxt build` succeeds and emits a valid `chrome-mv3` bundle whose manifest matches those declarations.

## Evidence Required
- [ ] WXT config → `wxt.config.ts`
- [ ] Successful build log (`wxt build`) → recorded in evidence manifest
- [ ] Built manifest inspection → `.output/chrome-mv3/manifest.json`

## Verification Method
Run `wxt build`; parse the emitted `manifest.json` and diff permissions/host_permissions against the gate declaration.

## Owner
Senior Software Engineer
