---
'documents-processing': patch
---

Fill the trip from a booking, and cut the form at its own sections.

Three faults, each visible on one filled form:

The ward was invented rather than matched. A ward name was written as
`PHUONG <NAME>` and handed to the dropdown, which held no such option, so the
field failed and the fill was attempted again and again. Viet Nam has merged
its wards, so a booking may still name one the form has dropped: the ward is
now placed against the list the site is offering for its province, and a ward
that has been absorbed lands on the city's own ward.

The border gate was never read out of the message. `canonicalBorderGate` could
resolve "Bo Y International Border Gate" to "Bo Y Landport", but nothing
extracted a gate from free text, so the defaults stood. A line naming a gate
now sets both the way in and the way out.

The address went on the form as the street alone. The box asks for the whole
temporary address, so it is written as the site's own example gives it —
street, ward, city — in English, whatever language the booking displayed.

The sections sent to the applicant are now cut at the form's own headings,
measured from the page, so each picture is one part of the form and carries
that part's name.
