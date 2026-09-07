# Vietnam e-visa form filler

Prefills the Vietnam e-visa application at
<https://evisa.gov.vn/e-visa/foreigners> from documents you already have, then
hands the browser to you.

**The form is never submitted.** The tool fills the fields, takes a screenshot
if you ask for one, and leaves a headed browser open so you can check every
value and press submit yourself. Submitting means signing a legal declaration,
and only the applicant can do that.

## Quick start

```bash
node src/evisa-apply.mjs --input applicant.json --dry-run
```

`--dry-run` resolves and validates the data without opening a browser. Once it
reports no errors, drop the flag to fill the form:

```bash
node src/evisa-apply.mjs \
  --input applicant.json \
  --portrait photos/PERSON-PHOTO.jpg \
  --passport passports/PERSON-PASSPORT.jpg \
  --screenshot
```

## Inputs

`--input` accepts any of the following, and may be repeated:

| Input             | Behaviour                                                           |
| ----------------- | ------------------------------------------------------------------- |
| `.json`           | Read directly; a record nested under `applicant` is used            |
| `.lino`, `.links` | [Links notation](https://github.com/link-foundation/links-notation) |
| `.jpg`, `.png`    | Treated as a document; OCR'd with `--ocr`                           |
| `.pdf`            | First page rendered, then treated as an image                       |
| folder            | Every recognized file inside, recursively                           |
| `.zip`            | Extracted to a temporary directory, then read as a folder           |

Sources are merged left to right, and **a later source wins**. That is how a
verified record overrides raw OCR:

```bash
node src/evisa-apply.mjs --input scans/ --input verified.json --ocr
```

Field names are flexible: `last_name`, `lastname`, `family_name` and `surname`
all mean the same thing. Anything unrecognized is reported as a warning rather
than silently dropped.

## Using a passport, with or without OCR

With `--ocr`, the passport's machine-readable zone is read and converted into
surname, given names, passport number, nationality, date of birth, sex and
expiry date.

Every MRZ field carries a check digit. When one fails, the value is still used
but reported so you can confirm it:

```
  ocr: passportNumber failed its MRZ check digit and needs review
```

If you already have verified data, skip `--ocr` and pass a JSON or lino file.

## Uploads

`--portrait` and `--passport` are prepared before upload: rotated upright,
converted to JPEG, and re-encoded at progressively lower quality until they fit
the site's 2 MB limit. The portrait is cropped to the 2:3 aspect of the required
4x6 cm photo.

Per the instruction page, the photo must be recent, front-facing, in formal
attire, with no hat and no glasses, on a white background.

A scan of the open passport shows two pages with the fold between them, and
the data page is cut out on that fold. Every column of the image is searched
for the crease, a shadow darker than the paper above and below it, and the row
that nearly every column dips at is the seam. Print never reaches both margins,
so a heading or the signature rule on the facing page cannot be mistaken for
it. The cut goes on the lower edge of the crease, where the data page's own
margin begins, and is kept only if the machine-readable zone still reads
afterwards.

Real scans never enter the repository, so the tests draw the shapes involved.
To check the cut on your own scans as well, name the folder holding them:

```sh
EVISA_SCANS_DIR=~/passports npm test
```

Uploads happen before any typing, because the site reads the passport image and
prefills fields from it; typing afterwards means your verified values win.

## Validation

Everything is checked before the browser opens, and all problems are reported
at once:

- required fields, and values longer than the form allows
- dates that are malformed, impossible (`31/02`), or in the past
- a validity window longer than the 90-day maximum, or ending before it starts
- an entry date outside the requested window
- an email that is malformed or does not match its confirmation
- a passport expiring within 6 months of entry (warning)
- border gates and purposes that the form's dropdowns do not offer (warning)

## Dates

Give an entry date and the validity window follows from it: `validFrom` is that
date and `validTo` is 89 days later, which is the full 90 the visa allows
counting both ends. A shorter window only limits you and costs the same.

State no entry date and it defaults to **a week out**, since processing takes
about three working days and a nearer date risks the visa arriving late.

## Wording the form expects

The site's dropdowns do not match the wording on its own instruction page. The
tool rewrites common phrasings automatically:

| You write                      | The form gets                   |
| ------------------------------ | ------------------------------- |
| `Tourism`, `holiday`, `travel` | `Tourist`                       |
| `work`, `employment`           | `Working`                       |
| `Noi Bai Airport Border Gate`  | `Noi Bai Int Airport`           |
| `Da Nang`                      | `Da Nang International Airport` |

An ambiguous name is left alone and flagged, rather than guessed at.

## Addresses in Vietnam

The form asks for the address in three parts — street, province/city, and
ward/commune — while an address from a booking or a map arrives as one line. Give
it whole and it is split:

```
406/14 Cong Hoa, Tan Binh District, Tan Binh, Хошимин, Вьетнам
```

| Field                          | Value                                    |
| ------------------------------ | ---------------------------------------- |
| Residential address in Vietnam | `406/14 Cong Hoa, Tan Binh, Ho Chi Minh` |
| Province/city                  | `HO CHI MINH City`                       |
| Ward / commune                 | `PHUONG TAN BINH`                        |

The address box holds the **whole** address, in the order the field's own
tooltip gives — premises, ward, city, as in its example
`Daewoo Hotel, 360 Kim Ma, Ba Dinh, Ha Noi`. The ward and city therefore appear
both in that line and in the dropdowns beside it, which is what the site's
example does too. Parts arriving in any other order are put into this one.

Typing the whole address does not populate the dropdowns: the box is a plain
text field with no lookup behind it, so all three are set separately.

The city is matched in English, Vietnamese or Russian, with or without
diacritics, so `Хошимин`, `TP Hồ Chí Minh` and `Saigon` all reach the same
option. The country is dropped: the form has no field for it. A venue name
before the street is kept.

**There is no district field, and no numbered wards.** Vietnam merged its wards
and abolished district-level administration in 2025, so the page now lists 167
named wards for Ho Chi Minh City and nothing like `Ward 13`. Guidance written
before that reform will not match the form. A district in a pasted address is
used to identify the ward and then dropped from the dropdown; a part naming no
ward the page offers is left out of the dropdown but kept in the address line,
since an officer reading it is better served by the applicant's own wording.

The ward list is read from the page, since it depends on the province selected
and changes when boundaries are redrawn.

An applicant who states no address gets `406/14 Cong Hoa, Tan Binh, Ho Chi Minh`,
because all three fields are required and someone who has not booked yet still
has to enter one. Naming another city leaves the ward empty for validation to
ask about, since a ward belongs to one city and the default's would place them
somewhere they never said. Every value stays editable in the browser.

## The Telegram bot

The same filling runs behind a bot that collects documents in conversation, in
English or Russian. It asks the live form what is required rather than carrying
its own list, fills after 45 seconds of quiet, and replies with a full-height
screenshot. It never submits.

```sh
cp .env.example .env        # then put the @BotFather token in it
node src/evisa-bot-run.mjs
```

### In a container

Running it under Docker gives it a browser matched to the Playwright client and
keeps everything it writes in one volume.

```sh
docker compose up -d --build   # start, rebuilding if the source changed
docker compose logs -f         # watch what it is doing
docker compose down            # stop
```

`restart: unless-stopped` brings it back after a crash and after the machine
reboots, but leaves it down when it was stopped deliberately.

The token is read from `.env` at run time and never enters the image, so an
image that is pushed to a registry carries no secret.

Logs and received documents go to `/data`, a named volume, because `TMPDIR`
points there and the code asks the system where temporary files belong. To read
them:

```sh
docker compose exec evisa-bot cat /data/evisa-bot-debug.log
docker compose cp evisa-bot:/data ./bot-data     # or copy the lot out
```

That volume holds applicants' documents and a log containing their data. It
outlives the container, so removing it is a deliberate step:

```sh
docker compose down -v
```

The bot sweeps anything older than `EVISA_BOT_RETENTION_DAYS` (7) on startup and
daily. Set `EVISA_BOT_DEBUG=0` to log field names without values.

## Privacy

No applicant data is sent anywhere except the government form itself. The tool
makes no HTTP requests of its own; the only network traffic is the browser
navigating to `evisa.gov.vn`.

Everything it writes — the screenshot, the prepared images, the resolved
record — is derived from a passport and is ignored by git. `tests/evisa-privacy.test.js`
enforces this, so it cannot regress. Keep real documents outside the repository.

## Options

| Flag                | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `--input <path>`    | Add a source. Repeatable.                       |
| `--portrait <path>` | Portrait photo to upload.                       |
| `--passport <path>` | Passport data page to upload.                   |
| `--out <dir>`       | Output directory. Default `evisa-output`.       |
| `--ocr`             | Read the passport MRZ for missing fields.       |
| `--dry-run`         | Validate only; do not open a browser.           |
| `--screenshot`      | Save a full-page screenshot of the filled form. |
| `--emit-lino`       | Print the resolved record as lino notation.     |
| `--no-keep-open`    | Close the browser when done instead of waiting. |
