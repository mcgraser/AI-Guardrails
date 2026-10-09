# Detected Categories And Limitations

Privacy Guardrail detects a beta set of structured and free-text personal or sensitive data categories before paste.

Supported beta sites:

- `chatgpt.com`
- `chat.openai.com`
- `claude.ai`
- `gemini.google.com`

## Categories

| Group | Categories |
| --- | --- |
| Identity | `PERSON`, `USERNAME` |
| Contact | `EMAIL`, `PHONE`, `ADDRESS` |
| Financial | `CREDIT_CARD`, `IBAN`, `BANK_ACCOUNT`, `SSN` |
| Network | `IP_ADDRESS` |
| Location | `LOCATION` |
| Password | `PASSWORD` |
| Organization | `ORGANIZATION` |
| Low-signal | `URL`, `DATE`, `MISC` |

Low-signal categories can be noisy and may be disabled by default or tuned in settings.

## What Pattern Detection Handles Best

Pattern recognizers are strongest when the text has a stable format, such as email addresses, credit card numbers, IBANs, IP addresses, and some phone numbers.

How the pattern recognizers decide:

- **IBAN**: recognized with or without spaces between the groups, in upper or lower case, for every country in the IBAN registry. The value must have that country's exact length and correct check digits.
- **Credit card**: 16-digit numbers, optionally in groups of four, and 15-digit American Express numbers grouped 4-6-5. The number must pass the Luhn check. Numbers starting with 0 and numbers made of one repeated digit are ignored.
- **Phone**: international numbers starting with `+` (also with `(0)`, as in `+49 (0)30 …`), numbers with a leading `0` or `00`, including the German slash style `030/12345678`, and numbers in grouped formats such as `212-555-1234`. A phone number has 7 to 15 digits and never continues onto the next line. Pattern detection does not report as a phone number:
  - digit groups that belong to a longer code, such as the groups inside an IBAN
  - numbers in four-digit blocks, as on cards
  - amounts written with dot separators, such as `12.500.000`
  - numbers labelled as an invoice, order, ticket, reference, serial, version or ISBN number. This does not apply to numbers starting with `+`.
- **Date**: numeric dates must be plausible (day 1–31, month 1–12, a two- or four-digit year, one separator throughout). Written dates such as `January 15, 2024`, `15 January 2024` and `15. März 1990` are recognized.
- **IP address**: a dotted quad that is part of a longer dotted number, such as `1.2.3.4.5`, is not reported.

When two detections overlap, the more reliable one wins whatever its score: a value confirmed by a checksum (IBAN, credit card) beats an email address, which beats an IP address or SSN, then a phone number, then a date. A pattern detection beats an overlapping Local AI detection. If Local AI marks part of an IBAN-shaped value as a phone or card number, the whole value is reported as an IBAN. This includes values whose check digits are wrong.

## What Local AI Helps With

Local AI can help identify context-sensitive spans such as person names, organizations, addresses, locations, usernames, passwords, and miscellaneous sensitive phrases. It can still miss spans or flag harmless text.

## Known Limits

- Detection can miss sensitive content.
- Detection can flag text that is not sensitive in context.
- Ambiguous words, short names, code, tables, and unusual formatting can reduce quality.
- Identification numbers without their own category can be reported under the closest one. For example, a German tax ID written in groups such as `12 345 678 901` appears as a phone number. Customer and account numbers in phone-like groups are deliberately still reported as phone numbers rather than dropped.
- An IBAN-shaped value whose check digits are wrong, for example a typo or a placeholder such as `DE12 3456 7890 1234 5678 90`, is not reported by pattern detection. It is no longer reported as a phone or card number either. It is reported as an IBAN only if Local AI flags it.
- Version numbers in date form, such as `1.10.20`, can still be reported as dates.
- Local AI can be unavailable, slow, or degraded depending on browser and device resources.
- Restoration depends on local placeholder or vault records and may not handle every response rewrite.
- Unsupported sites are outside the first public beta scope.

Privacy Guardrail supports local review before sending. It does not guarantee perfect detection, prevention, or regulatory compliance.
