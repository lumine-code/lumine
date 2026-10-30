# Scrollbars

Core owns scrollbar geometry, pointer input and visibility. Existing DOM scrollports keep their wheel, keyboard and programmatic scrolling; virtual editors provide logical coordinates through an adapter. Scrollbar chrome never wraps or reparents authored content.

Presentation follows the scroll surface's semantic role:

- A primary `document` uses persistent overlay tracks, with `--scrollbar-border-color` marking the vertical separator. Its editor text wraps before a stable scrollbar inset; cursor reveal and horizontal end padding use the same inset.
- A primary `panel` uses overlay tracks that fade in on hover or keyboard focus and remain visible during dragging. Their appearance does not change the content viewport, and they have no document separator. This applies to utility views such as Settings even when opened in the center.
- `inline` surfaces, including inline REPL results, embedded editors, modal lists and isolated output frames, reserve the old scrollbar space and keep overflowing axes visible. DOM scrollports reserve space only for overflowing axes. Fixed-width virtual editors keep their stable vertical text inset even when the rail is hidden; auto-width editors add that space only when vertical scrolling is possible. Tracks without overflow stay hidden.

Without an explicit role, a center pane's primary scrollport defaults to `document`, a dock's primary scrollport defaults to `panel`, and nested surfaces default to `inline`. Packages can declare `kind: "document" | "panel" | "inline"` when attaching a scrollport, or set `data-scrollbar-kind` on the element. A pane item's root may provide the same attribute as a hint for its primary scrollports. An ancestor's role hint never applies to nested scrollports: a panel's embedded editors, result lists and other inner content retain their inline defaults unless marked explicitly.

Track clicks immediately center the thumb at the clicked point and cancel previous scrolling destinations. Thumb movement has no positional animation.

## DOM surfaces

Existing `overflow: auto` and `overflow: scroll` containers are discovered when layout subtrees mount. Editor internals, renderer-owned scrollbars and intentional exclusions are skipped. Geometry updates are batched through the document read/write scheduler; ordinary scroll events update thumb transforms without rescanning layout or redrawing markers. Direct-child resize observations and subtree changes invalidate content extents.

Views with sticky content may pass a numeric `zIndex` when attaching their primary scrollport. This keeps the rail above the view's header layer without shortening the track or changing the content viewport.

Packages may explicitly register a scrollport with `lumine.scrollbars.attach(element, options)`. Its `kind` selects the role described above. The `layout: "overlay" | "gutter"` option overrides content reservation; `policy: "auto" | "always" | "hover"` controls visibility independently. Auto selects always-visible chrome for gutter layouts and document overlays, and transient chrome for panel overlays. Other options are `edge: "left" | "right"`, `focusOwner`, and `horizontal`/`vertical` booleans that enable or disable each axis. The returned controller provides `refresh()` and `dispose()`; an inert document without a physical window returns null.

Use `data-scrollbar-layout="overlay"` on a primary scrollport, or `data-scrollbar-layout="gutter"` on a nested surface or enclosing subtree. Gutter layout is inherited from an ancestor; overlay layout applies only to the marked element, so nested content keeps its reserved gutter. Explicit attachment options and the element's own layout attribute take precedence over an ancestor. `data-scrollbar="auto"`, `data-scrollbar="always"` and `data-scrollbar="hover"` select visibility without an API call. The `data-scrollbar="none"` attribute excludes a surface and its descendants; use it for renderer-owned chrome or deliberately hidden horizontal controls. RTL containers put the vertical track on the left.

Gutter layouts preserve authored padding and let the browser reserve space only for existing overflow axes, with shared chrome drawn in that space. Their `clientWidth` and `clientHeight` already exclude reserved gutters; consumers must not subtract scrollbar thickness from those dimensions again. Editor internals are excluded from automatic DOM discovery, so packages embedding additional scrollports inside an editor register those surfaces explicitly or retain their native reserved scrollbars.

## Geometry and marker layers

`lumine.scrollbars.getGeometry(element)` accepts an editor element or DOM scrollport. It returns `layout` (`"overlay"` or `"gutter"`), `verticalSize` (vertical track width), `horizontalSize` (horizontal track height), `viewportWidth`, `viewportHeight`, `verticalTrackSize`, `horizontalTrackSize`, `scrollWidth`, `scrollHeight`, `canScrollVertically` and `canScrollHorizontally`. Dimensions use CSS pixels. Viewport dimensions exclude reserved gutters, and track lengths exclude the opposite scrollbar where the two rails meet. Thickness remains stable when the document fits or the thumb fades; for DOM gutter layout, the axis availability flags indicate whether that thickness occupies space. A fixed-width virtual editor's stable vertical inset is already excluded from its gutter viewport width. Editor snapshots additionally expose `rowGeometryVersion` so moved block decorations invalidate projections even when total height is unchanged.

`lumine.scrollbars.observe(element, callback)` publishes an immediate snapshot, then changed layout or geometry independently of scroll position. Dispose its return value with the consumer view. `getVerticalTrack(element)` exposes the local track for an informational canvas and attaches an unregistered DOM scrollport when needed. Marker layers use `pointer-events: none` and sit below the thumb; moving the thumb does not invalidate their pixels. The marker registry continues to own and share domain data with the minimap.

## Isolated documents

Trusted output frames receive `lumine.scrollbars.getFrameSource()`. This standalone browser script installs the same runtime and stylesheet as the parent, without Node integration. Construct `new window.LumineScrollbars.DOMScrollbarManager({document})` after the frame body exists and dispose the manager with the output. Without a primary pane item, discovered frame scrollports default to reserved, always-visible gutters; marking the frame body `data-scrollbar-layout="gutter"` also applies that layout to dynamically created nested content. Chrome is marked `data-scrollbar-chrome` so output serialization can omit it. Theme colors and track size are passed through the frame's existing theme-variable channel.

## Styling

`--scrollbar-size` controls ordinary tracks and `--scrollbar-size-editor` controls editor tracks and their text inset. The default is 10 pixels. Themes supply `--scrollbar-color`, `--scrollbar-color-editor` and optional hover colors; their values do not change geometry. Reduced-motion preferences disable visibility transitions. The scrollbar itself is presentation-only and does not enter keyboard focus order; navigation stays on the content surface.
