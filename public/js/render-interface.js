// Explicit synchronous dashboard redraw hook, wired by the entry point.
// Actions and authentication need a redraw, not a dependency on the view tree.
let redraw = () => {};

export function setRenderer(renderer) {
  redraw = renderer;
}

export function render() {
  redraw();
}
