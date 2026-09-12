---
'documents-processing': patch
---

Tell what a picture is before putting it on the form, and stop a refill loop.

A picture with no passport zone on it was taken to be the portrait, so a
screenshot of a hotel booking went into the portrait upload and the site
answered "no face detected". Each picture is now looked at on its own terms:
a face is measured, and a portrait is a face filling much of the frame while a
data page is a small face beside a great deal of print. A booking is read for
the address in Viet Nam, which the form asks for in three parts, so an address
written "25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам" gives the street, the
province and the ward each as the site's own dropdown spells it.

Also fixed, from one testing session:

- The warning about sending a photo rather than a file was repeated for every
  picture; it is said once, and every picture is used either way.
- An empty review page was answered by filling the form again, with no limit,
  so a site-side failure looped. Two tries, then the applicant is told.
- A capture could be taken before the uploaded pictures had loaded, showing
  empty frames; it now waits for every image on the page.
- The border-gate list held 14 airports out of the 79 gates the site offers,
  so "Bo Y International Border Gate" matched nothing. All 79 are listed, and
  a bare city name still resolves to its airport.
- "Дата вьезда", the common spelling of "въезд", was not read as an entry date.
- The filled form went as a PDF; it goes as the full picture again, with each
  section following as its own message so the form unrolls down the chat. The
  site's banner and footer are left off, and each section says which it is.
- A note about a hyphen the site refuses was printed for dates, where it says
  nothing worth reading. Names only.
