# atom-theme

The classic Atom day and night UI and syntax themes.

A port of the original `atom-dark` and `atom-light` themes, converted from Less
to CSS custom properties and brought up to the current DOM. The palettes are the
originals; what changed is everything the classic themes could not have known
about.

## Features

- **Trapezoid tabs**: the signature sloped tab edges, drawn with skewed pseudo-elements over a recessed tab bar.
- **Original palettes**: every colour is the classic value, with each Less colour function resolved to a concrete one.
- **Day and night pair**: `atom-day-ui`/`atom-day-syntax` and `atom-night-ui`/`atom-night-syntax` follow the system theme mode out of the box.
- **Standalone**: ships its own complete UI layer and syntax rules, so it does not inherit from any other theme package.
- **Gradient chrome**: gradient buttons, gradient panel headings, and the striped progress bar of the era.
- **Inverted tooltips**: a light tooltip on the dark theme and a dark one on the light theme, as in the originals.
- **Modern coverage**: docks, the status bar, notifications, form controls, and the modal backdrop are styled too — none of them existed when these themes were written.

## Theme pack

The package declares its four themes as the **Atom** pack. Use
`theme-selector:toggle` to preview and select it.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
