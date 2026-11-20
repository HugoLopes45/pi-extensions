import type { EntryRenderer, MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
  MouseRegion,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** A custom message or entry renderer: Pi's `MessageRenderer` and `EntryRenderer` have this shape. */
type ItemRenderer<Item extends WeakKey, Options extends { expanded: boolean }, RenderTheme> = (
  item: Item,
  options: Options,
  theme: RenderTheme,
) => Component | undefined;

/**
 * A clicked item's own view, kept per message or entry object because Pi rebuilds their components
 * on invalidation. `global` is Pi's expanded flag when the item was clicked: once ctrl+o changes it,
 * the click is forgotten, as Pi's tool rows forget theirs.
 */
const clickedViews = new WeakMap<WeakKey, { global: boolean; expanded: boolean }>();

function viewFor(item: WeakKey, global: boolean): boolean {
  const clicked = clickedViews.get(item);
  if (clicked?.global === global) return clicked.expanded;
  clickedViews.delete(item);
  return global;
}

/** Renders one item and swaps between its views on a left click its content does not handle. */
class ExpandOnClick implements Component {
  private region: MouseRegion;

  constructor(
    child: Component,
    private readonly item: WeakKey,
    private readonly global: boolean,
    private readonly build: (expanded: boolean) => Component | undefined,
  ) {
    this.region = this.wrap(child);
  }

  private wrap(child: Component): MouseRegion {
    return new MouseRegion(child, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const expanded = !viewFor(this.item, this.global);
      const next = this.build(expanded);
      if (!next) return undefined;
      clickedViews.set(this.item, { global: this.global, expanded });
      this.region = this.wrap(next);
      return { handled: true };
    });
  }

  render(width: number): string[] {
    return [...this.region.render(width)];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.region.handleMouse(event);
  }

  invalidate(): void {
    this.region.invalidate();
  }
}

function expandOnClick<Item extends WeakKey, Options extends { expanded: boolean }, RenderTheme>(
  render: ItemRenderer<Item, Options, RenderTheme>,
): ItemRenderer<Item, Options, RenderTheme> {
  return (item, options, theme) => {
    const build = (expanded: boolean) => render(item, { ...options, expanded }, theme);
    const child = build(viewFor(item, options.expanded));
    return child && new ExpandOnClick(child, item, options.expanded, build);
  };
}

/**
 * Lets a click toggle a custom message between its Collapsed and Expanded View, as Pi's tool rows
 * and built-in messages do. Pi's custom-message host has no click handling of its own, so wrap the
 * renderer passed to `registerMessageRenderer`. ctrl+o still sets every item.
 */
export function expandMessageOnClick<T>(render: MessageRenderer<T>): MessageRenderer<T> {
  return expandOnClick(render);
}

/** `expandMessageOnClick` for the renderer passed to `registerEntryRenderer`. */
export function expandEntryOnClick<T>(render: EntryRenderer<T>): EntryRenderer<T> {
  return expandOnClick(render);
}
