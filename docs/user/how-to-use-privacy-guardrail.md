# How To Use Privacy Guardrail

Privacy Guardrail reviews pasted text locally before it is inserted into a supported LLM chat page.

Supported beta sites:

- `chatgpt.com`
- `chat.openai.com`
- `claude.ai`
- `gemini.google.com`

## Paste Review

1. Copy text you want to paste.
2. Paste into a supported chat input.
3. If the paste is long enough to scan, Privacy Guardrail checks it locally.
4. Review the detected spans before insertion.
5. Keep the spans you want anonymized and ignore spans you do not want changed.
6. Confirm the reviewed paste.

When no supported span is found, the extension allows the paste without showing the full review overlay.

## Placeholders

Accepted spans are replaced with typed placeholders such as:

```text
[EMAIL_1]
[PERSON_1]
[CREDIT_CARD_1]
```

The placeholder map is stored locally so that supported responses can be restored later. Placeholder numbering is stable for the local identity vault where the same original value is reused.

## Ignoring Detections

The review UI lets you ignore a detection for the current paste when it is not sensitive in context. Ignored text is pasted unchanged.

For repeated false positives, use the extension settings to add allowlist entries or adjust category sensitivity.

## Restoration

On supported chat pages, Privacy Guardrail watches model responses for placeholders and restores known originals locally where supported. Restoration depends on the local placeholder or vault record still being available. If the model rewrites a placeholder heavily, restoration may be incomplete.

## Uploading Files

When you upload a Word, Excel, PowerPoint or PDF file to a supported chat site — through the attach button, by dragging it onto the page, or by pasting a copied file — Privacy Guardrail holds the upload and checks the file's text first. This includes text you might not see on screen: comments, tracked deletions, speaker notes, hidden worksheets, filled-in PDF form fields, and document properties such as the author.

- If nothing is found, the upload continues and a short confirmation appears.
- If personal data is found, a warning lists each file with the kinds of data found, how often, and a few examples. Choose **Upload anyway** to send the file unchanged, or **Don’t upload** to keep it off the page.
- If a file cannot be checked — a scanned PDF without a text layer (there is no OCR), a password-protected file, or a file larger than 25 MB — the warning says so and asks the same question.

Files are never modified: the warning is a prompt to remove the data in the original application before uploading. The same category, allowlist and sensitivity settings that apply to pastes apply to files. File scanning can be switched off in the popup under **Settings → Scan file uploads**.

## Canceling A Scan

If a scan is taking too long, use the cancel control. Depending on your settings, the extension may ask whether to paste the original text or drop the pending paste.

Privacy Guardrail is an assistive beta tool. Review the final text yourself before sending it.
