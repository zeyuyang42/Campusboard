import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { TagLinks } from "../src/components/TagLinks";
import { libraryTagPath } from "../src/lib/navigation";
import { useUi } from "../src/ui/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUi.getState().setLibraryQuery("");
});

/** Where the router is, and the tag the Library grid would read from it. */
function Probe() {
  const loc = useLocation();
  const [params] = useSearchParams();
  return h("output", { "data-path": loc.pathname, "data-tag": params.get("tag") ?? "" });
}

describe("album tags as links (#71)", () => {
  it("builds an encoded Library path", () => {
    expect(libraryTagPath("drum & bass")).toBe("/library/albums?tag=drum%20%26%20bass");
  });

  it("navigates in-app to the Library narrowed to the tag and clears the filter text", () => {
    useUi.getState().setLibraryQuery("old filter");
    act(() => root.render(
      h(MemoryRouter, { initialEntries: ["/album/1"] },
        h(Routes, null,
          h(Route, { path: "/album/:id", element: h(TagLinks, { tags: ["Électronique", "drum & bass"] }) }),
          h(Route, { path: "/library/:tab", element: h(Probe) }),
        )),
    ));
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a.tag")];
    expect(links.map((a) => a.textContent)).toEqual(["Électronique", "drum & bass"]);
    act(() => links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    const out = host.querySelector("output")!;
    expect(out.dataset.path).toBe("/library/albums");
    expect(out.dataset.tag).toBe("drum & bass");
    expect(useUi.getState().libraryQuery).toBe("");
  });

  it("renders nothing for an album without tags", () => {
    act(() => root.render(h(MemoryRouter, null, h(TagLinks, { tags: [] }))));
    expect(host.innerHTML).toBe("");
  });
});
