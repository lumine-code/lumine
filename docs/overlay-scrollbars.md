# Overlay scrollbars

Core owns scrollbar geometry, pointer input and visibility. Existing DOM scrollports keep their wheel, keyboard and programmatic scrolling; virtual editors provide logical coordinates through an adapter. Scrollbar chrome never wraps or reparents authored content.

The editor uses its full viewport and reserves a separate stable text inset for wrapping, cursor reveal and horizontal end padding. Dock tracks fade in on hover or keyboard focus and remain visible during dragging. Main document tracks stay visible and use `--scrollbar-border-color` for their separator. Track clicks immediately center the thumb at the clicked point and cancel previous scrolling destinations. Thumb movement has no positional animation.

## DOM surfaces

Existing `overflow: auto` and `overflow: scroll` containers are discovered when layout subtrees mount. Editor internals, renderer-owned scrollbars and intentional exclusions are skipped. Geometry updates are batched through the document read/write scheduler; ordinary scroll events update thumb transforms without rescanning layout or redrawing markers. Direct-child resize observations and subtree changes invalidate content extents.

Packages may explicitly register a scrollport with `lumine.scrollbars.attach(element, options)`. Options include `policy: "auto" | "always" | "hover"`, `edge: "left" | "right"` and `focusOwner`. Auto derives persistence from the pane location; hover forces transient chrome even within a document pane. The returned controller provides `refresh()` and `dispose()`; an inert document without a physical window returns null. The `data-scrollbar="none"` attribute excludes a surface and its descendants; use it for renderer-owned chrome or deliberately hidden horizontal controls. `data-scrollbar="auto"` and `data-scrollbar="always"` select a visibility policy without an API call. RTL containers put the vertical track on the left.

## Geometry and marker layers

`lumine.scrollbars.getGeometry(element)` accepts an editor element or DOM scrollport. It returns `verticalSize` (vertical track width), `horizontalSize` (horizontal track height), `viewportWidth`, `viewportHeight`, `verticalTrackSize`, `horizontalTrackSize`, `scrollWidth`, `scrollHeight`, `canScrollVertically` and `canScrollHorizontally`. Track lengths exclude the opposite scrollbar where the two rails meet. Thickness remains stable when the document fits or the thumb fades. Editor snapshots additionally expose `rowGeometryVersion` so moved block decorations invalidate projections even when total height is unchanged.

`lumine.scrollbars.observe(element, callback)` publishes an immediate snapshot, then changed geometry independently of scroll position. Dispose its return value with the consumer view. `getVerticalTrack(element)` exposes the local track for an informational canvas. Marker layers use `pointer-events: none` and sit below the thumb; moving the thumb does not invalidate their pixels. The marker registry continues to own and share domain data with the minimap.

## Isolated documents

Trusted output frames receive `lumine.scrollbars.getFrameSource()`. This standalone browser script installs the same runtime and stylesheet as the parent, without Node integration. Construct `new window.LumineScrollbars.DOMScrollbarManager({document})` after the frame body exists and dispose the manager with the output. Chrome is marked `data-scrollbar-chrome` so output serialization can omit it. Theme colors and track size are passed through the frame's existing theme-variable channel.

## Styling

`--scrollbar-size` controls ordinary tracks and `--scrollbar-size-editor` controls editor tracks and their text inset. The default is 10 pixels. Themes supply `--scrollbar-color`, `--scrollbar-color-editor` and optional hover colors; their values do not change geometry. Reduced-motion preferences disable visibility transitions. The scrollbar itself is presentation-only and does not enter keyboard focus order; navigation stays on the content surface.
