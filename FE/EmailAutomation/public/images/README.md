# public/images

Images used by the login page (`src/app/features/login`). No code change is
needed to swap either one — replace the file at the same path.

- `login-hero.jpg` — the left-hand building photo. The navy overlay is
  applied in CSS, so any dusk/evening architecture shot works. To point at a
  different file name, change `$hero-image` at the top of `login.scss`.
- `pride-logo.png` — the official PRIDE logo, shown on the hero and at the
  top of the sign-in card. Until this file exists the page shows a
  placeholder text lockup instead (see `.brand-logo-fallback` in
  `login.scss`). A transparent PNG (or swap the `src` in `login.html` to an
  `.svg`) at roughly 400px tall gives the sharpest result.
