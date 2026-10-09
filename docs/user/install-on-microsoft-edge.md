# Install On Microsoft Edge

Privacy Guardrail runs in Microsoft Edge with the same package as in Chrome. Edge is built on Chromium and supports every extension API Privacy Guardrail uses.

## Requirements

- Microsoft Edge desktop stable (Windows, macOS or Linux), version 116 or newer.
- One of the supported chat sites: `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`.
- The Local AI requirements are the same as in Chrome — see [Local AI explained](local-ai-explained.md).

## Install From The Chrome Web Store

Edge can install extensions from the Chrome Web Store:

1. Open the Privacy Guardrail Chrome Web Store listing in Edge.
2. When Edge shows the banner about extensions from other stores, select **Allow extensions from other stores**, then confirm.
3. Select **Get extension** / **Add to Chrome**, and confirm the permission prompt.
4. Refresh any supported chat tab that was already open.

Edge keeps extensions from the Chrome Web Store up to date automatically.

## Install A Release ZIP Manually

1. Download the release ZIP from GitHub Releases and verify it against the published SHA-256 checksum.
2. Unzip it into a folder you will keep.
3. Open `edge://extensions`.
4. Turn on **Developer mode** (left sidebar or bottom of the page).
5. Select **Load unpacked** and choose the unzipped folder (the one that contains `manifest.json`).
6. Refresh any supported chat tab that was already open.

Manually loaded extensions are not updated automatically; repeat the steps for each release.

## Managed Devices

If your organization manages Edge, extensions from outside the Microsoft Edge Add-ons store may be blocked by policy (`ExtensionInstallBlocklist`, `ExtensionInstallSources`). Ask your administrator to allow the extension, or to deploy it via `ExtensionInstallForcelist`.

## Confirm It Is Active

Open a supported chat site and select the Privacy Guardrail icon in the toolbar (pin it from the puzzle-piece **Extensions** menu if it is hidden). The popup shows whether protection is on.
