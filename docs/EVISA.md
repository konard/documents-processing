# Vietnam e-visa form filler

Prefills the Vietnam e-visa application at
<https://evisa.gov.vn/e-visa/foreigners> from documents you already have, then
hands the browser to you.

**The command-line tool never presses Next.** It fills the fields, ticks the
four declarations under the form, takes a screenshot if you ask for one, and
leaves a headed browser open so you can check every value and go on yourself.
The Telegram bot presses Next, but only on the applicant's word and after a
countdown they can stop: the declarations are theirs, and the fee is not
refunded when an application is refused.

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

## Home addresses

The permanent, contact and emergency addresses are copied onto the form as
written, in Latin letters. An address written the Russian way carries markers
that mean nothing once transliterated, so those are translated or dropped, the
country, the regions and the best-known cities get their English names
(`Московская область` is `Moscow Region`, `Краснодарский край` `Krasnodar
Krai`), a street's type becomes the English word after its name (`ул.
Ленина` is `Lenina street`, `Невский проспект` `Nevskii avenue`), the house
follows the street without a comma, and the rest is spelled the way the
passport's machine-readable zone would spell it:

```
Россия, г. Москва, 101000, ул. Пушкина, д. 10, корп. 2, кв. 5
```

becomes

```
Russian Federation, 101000, Moscow, Pushkina street 10, bld. 2, apt. 5
```

A Russian address is put into one order however it was written: country,
postal code, region, city, street, house, building, flat. One typed in Latin
letters for a Russian house (`RUSSIAN FEDERATION, PUSHKINA STREET 10,
APARTMENT 5`) is taken apart the same way and comes out in the same order.
Every address is then written one way: names with a capital first letter,
markers and street types in lower case, house letters in capitals, and the
country by one spelling (`Russian Federation`, never `Russia` or `RUSSIA`),
so the permanent, contact and emergency addresses read alike on the form.
The place of birth is the exception: it is rendered as the passport prints
it, `Г.МОСКВА/RUSSIA` as `Moscow, Russia` and `Г.МОСКВА/USSR` as `Moscow,
USSR`, since it is the passport's statement, not an address. An
address from elsewhere keeps its own order and gets only its case settled. Units written without commas (`г. Москва ул. Пушкина
д. 10 кв. 5`) are split apart, and a remark after a dash or in brackets
(`- адрес для всех`) is dropped.

The bot also checks each address against OpenStreetMap, through the Photon
service (`EVISA_GEOCODER_URL` to point elsewhere). The map is asked in
Cyrillic, a Latin-typed street spelled back near enough for its fuzzy search,
and the answer counts only when it is a house of the number asked for on a
street of the same name. Then the rendering is built from the map's own
country, postal code, city and street, with the applicant's building and flat
kept, so a Latin-typed address gains the postal code and city it lacked. A
different house, a postal code the map contradicts, or no answer at all leaves
the address as written, rendered as above. The log says which happened, and
says when two addresses in the chat are the same flat of the same house on the
map, which is how two spellings are known to be one address.

## The printed side of the passport

The machine-readable zone carries no issue date, place of birth or issuing
authority, and the form asks for all three. They are read off the printed side
of the data page, anchored on the dates the zone does give: the issue date
shares a row with the expiry, the place of birth follows the date of birth,
and the authority is printed under the issue date. The print is read from the
black-ink layer of the page at several thresholds and the readings vote; a
value with no clear winner is left for the applicant to type. A faint or
overprinted scan yields nothing rather than a guess.

A place of birth printed as `Г.МОСКВА/USSR` reaches the form as `Moscow,
USSR`; an authority printed as `[REDACTED]` as `MVD 0073`. Reading the Cyrillic
half needs the Russian model (`tesseract-ocr-rus`), which the container image
carries; without it the Latin halves alone are read.

## The Telegram bot

The same filling runs behind a bot that collects documents in conversation, in
English or Russian. It asks the live form what is required rather than carrying
its own list, fills after 20 seconds of quiet, and replies with a full-height
screenshot and an explanation of what went where. It presses Next only on
the applicant's word.

A line of a message that reads as a postal address, by its markers or postal
code, is taken as the permanent address; a label such as `Contact address:`
in front of it sends it to that field instead. A phone or email on the same
line goes to its own field. The contact address is taken to be the permanent
one unless given, and the purpose of the trip to be tourism.

The contact person is read from a block opened by `Контакт:`, `Emergency
contact:` or a relation on its own, `Сестра:`, `Тётя:` or `Brother:`,
running to the next blank line: a line of two to four words is their name,
an address line their address, a phone theirs, and the relation in the
heading is the
relationship. A second phone anywhere, or one preceded by a word such as
`сестра` or `brother`, is the contact's too, and that word becomes the
relationship. `Номер контакта +7...` on its own is their phone. A line about
the flight or the entry gives the entry date, in digits or in words: `Дата
билетов на самолёт: 16 сентября 2026 года`. Typed passport details are read
with their labels: `дата выдачи 17.02.2020`, `место рождения: Тула`, `орган:
МВД 0001`.

A passport photo is read by every OCR engine at hand, in parallel, over
three renderings of the image: the photo as it is, a grey enlarged copy with
its contrast stretched, and the dark ink alone with the security pattern
dropped. The engines are Apple's Vision framework on macOS, RapidOCR,
PaddleOCR and Tesseract; each Python one is retried once on a failure and
held to a time budget. Every value on the page is printed twice, in the
machine-readable zone and in the print above it, and both are read from
every engine's lines: the number, the dates, the sex, the names, and what
the zone lacks, the issue date, the place of birth, the authority and a
hyphen in a name. Each reading is a vote, a zone value whose check digit
holds counts double, and a field is settled by two votes with a clear
lead; a place one misread letter apart is one reading, a code one digit
apart is not. The fast engines and Tesseract run first, on the photo and
the grey copy; PaddleOCR and the ink rendering follow only when a field is
still open. A field the readings split on is not put on the form: the
summary names the readings in bold and asks which is right, and the log
says who read what. The older `passport-crosscheck.mjs` and
`mrz-consensus.mjs` hold the same idea for the zone alone. A passport issued at a consulate names its authority without
a code, `Г/К РОССИИ, <city>`, and is read as such; a given name the passport
hyphenates, `JOHN-ALEX`, is read off the print, since the zone
writes the hyphen as a filler, and goes on the form with a space, which the
site takes, with a note in the summary saying so. So one message can carry the email, the flight date, the address
and phone, and the contact's name, address and phone under `Сестра:`, sent
alongside the passport and the portrait.

Once the chat has been quiet for 20 seconds the form is filled, with no
pause to read anything over first: filling changes nothing that cannot be
changed again, and `/start` has already opened the browser, so nothing
waits on that either. The fill also ticks the four declarations under the
form, the commitment to declare temporary residence, that the statements
are true, compliance with Vietnamese law on entry, and that the instructions
were read, since Next stays disabled until they are; the caption names the
ones it ticked.

After the fill come two messages. First the captured page as a file, with
the fill's outcome in its caption: how many fields went in, how many the
site read from the passport itself and whether they matched, what the site
had read differently, which declarations were ticked, what could not be
filled, and either what is still needed or that the form waits for the word
to send. Then the explanation: what went on the form, grouped as the form
is, applicant, passport, contacts, emergency contact, trip. A value the
applicant did not give is marked `(assumed)` or `(по умолчанию)`, and a
note under the list says to send the wanted value if any of it is wrong. A
value that follows from one they gave is marked with its source instead:
the contact address `(same as the permanent address)`, the visa's first day
`(the entry date)`, its last day `(90 days, the most an e-visa allows)`. No
address, phone or name is ever a default; the only defaults are the trip's
purpose, gates, province and a hotel address in Ho Chi Minh City, the
passport type and the religion. The explanation is its own message because
Telegram's caption limit would cut a list of forty values short.

The site is one page that swaps its content: the address never changes,
and the step bar at the top, "Fill out the Application form", "Review
application form", "Payment", says where it is. The bot reads the stage
from there.

The steps the bot takes only on the applicant's word are the Nexts. A
message that is only a word to send, `Отправляй`, `Отправь`,
`Подтверждаю`, `send`, `go`, `yes`, on the filled form presses Next at
once: the site answers with the application laid out for review, with a
Back button, and nothing is sent yet. The bot sends that page as a file,
then the captcha at its foot as a picture, enlarged, and asks for its code.
A message that is only the code, four to eight letters and digits, is typed
in; then comes the one countdown, of 30 seconds, said in the chat, since
the Next that follows sends the application on to payment. `Стой`, `стоп`,
`отмена`, `stop` or `cancel` during it drops the step, a second word to
send skips the rest of the wait, and new details drop it too. When the
countdown runs out the bot presses Next, waits for the page to settle, and
sends what it shows as a file. When the site accepted the code it puts up
a dialog over the review page, "DECLARATION COMPLETED", with the
electronic document code that checks the application's status later; the
step bar does not move for it, so the bot reads the dialog itself as a
stage of its own. The dialog is relayed line by line under a capture of
the screen, and that is where the bot stops: Confirm in the dialog and
the payment after it are the applicant's to do in the browser window, and
the bot says so, again to any word to send from then on. Nothing in a
dialog is ever pressed by the bot. When the site refused the code the review page
is sent again with what the site said, "Captcha invalid", under it,
followed by a fresh picture to read, as many times as it takes. A code sent during the countdown replaces the one typed, and the
countdown starts over. The form is never filled again for a refused code,
and nothing sent on the review page fills it. A word to send on
a later stage counts down and presses that stage's Next in the same way. A
word to send while something has arrived since the last fill fills first,
since the applicant confirms what they have seen, and `/fill` fills at
once.

Details sent after the site has taken the form cannot reach it, and the bot
says so: the page is corrected in the browser, or the application starts
over with `/start`. A stop word during a fill already under way is answered
with that, and the fill runs on; Next is never pressed by a fill.

A capture is of the whole page, however far it scrolls, except while a
dialog stands over it: a dialog locks the page, and a capture of the whole
page then comes out as the dialog over one screen and a long blank tail,
so the screen alone is captured.

What the browser reports goes to the log as well: console errors and
warnings, script errors, requests that failed, and answers of 400 and up,
each with its chat. With `EVISA_BOT_CDP_PORT=9222` every browser the bot
opens listens for a debugger on a port of its own from there up, and the
log names it when the browser opens; `chrome://inspect` in another Chrome,
with that port added under "Configure", or Playwright's `connectOverCDP`
then shows and drives the very page the bot is on.

For diagnosis, the bot keeps the page's markup at three moments under the
system temp directory, in `evisa-markup-*` directories: the empty form, the
filled form, and the page after each Next. A site that has changed shows
in the first; a fill that went wrong, in the second. They hold the
applicant's details, so they are written only when values are allowed in
the log, and the daily sweep removes them with the documents.

With `EVISA_BOT_HEADED=1` each chat's browser is a visible window, for an
operator at the machine who wants to watch the fill or take over. A fill that
fails is logged whole and reported to the chat, and the browser is left open
with the form as far as it got, so the applicant or the operator can carry
on by hand in the same window.

Photos should be sent to the bot as files, not as photos: Telegram shrinks a
photo to a few kilobytes and strips what the camera wrote, and the site then
warns that the portrait "was captured from another source". A file arrives
byte for byte. A picture that arrives as a photo is used, and the bot says
so each time, with its size and how to send it as a file instead. One under the site's 2 MB limit is uploaded as it is; a
camera original over it is shrunk with its metadata kept.

While the bot reads a document, waits out the quiet window or fills the form
it shows the "typing" status in the chat and sends no message about it; the
reading runs on a worker thread so the status and other chats are not held
up. The screenshot is sent
as a file, not a photo, because Telegram shrinks a photo to fit a screen and a
page several screens tall comes out unreadable. It is taken once the page has
stopped changing and every value set is on it; a field the page emptied while
re-rendering is set again first.

A window the applicant closes, or a browser that crashes, is noticed the
moment it happens: the chat is told, what was on the page is forgotten,
and a word to fill opens a new window and fills it again from what the
chat has sent. On a restart of the bot every chat with a browser is told
that the window closes with it.

Each chat keeps one browser for the whole conversation. A second fill uploads
nothing the page already has and types nothing already on it, and the summary
lists only what has not been said before. `/start` reuses the browser, with
the form reloaded empty; a browser that has died is replaced on the next use;
one whose chat has been quiet for five hours is closed.

```sh
cp .env.example .env        # then put the @BotFather token in it
node src/evisa-bot-run.mjs
```

### In a container

Running it under Docker gives it a browser matched to the Playwright client, the
`tesseract` command that reads the passport, and one volume for everything it
writes.

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
