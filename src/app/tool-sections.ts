import type { Tool } from '../types';

type ReadingLocation = { revision: string; page: number; top: number; left: number };

/** What the tool sections need from the app around them. */
export type ToolSectionsHost = {
  /** The section shown: a tool, the catalogue ('home'), Editar PDF ('edit-pdf'), or none. */
  section: () => string | null;
  setSection: (section: string | null) => void;
  /** Editar PDF covers the reader on desktop and tablet; on phones it is a sheet over it. */
  inline: () => boolean;
  /** An edit waits to be applied or discarded. */
  draft: () => boolean;
  /** The page being read, the document's revision and the tab in front. */
  page: () => number;
  revision: () => string | number | undefined;
  activeKey: () => string | null;
  tool: () => Tool;
  setTool: (tool: Tool) => void;
  clearArea: () => void;
  /** Stops a pending restore of the reader's scroll position. */
  cancelScrollRestore: () => void;
  /** Shows a page at an exact scroll position, or scrolls to a page. */
  showAt: (page: number, top: number, left: number) => void;
  goToPage: (page: number) => void;
};

/** The tool sections over the reader, and Editar PDF in its place. Closing Editar PDF brings
 * the reader back where it was left, unless the page or the document changed meanwhile. */
export class ToolSections {
  /** Set on each render, as EditStore's actions are. */
  host!: ToolSectionsHost;
  /** The reader is being put back after Editar PDF: page tracking waits. */
  restoring = false;
  private location: ReadingLocation | null = null;
  private requests = 0;

  /** Where the reader was when Editar PDF opened over it. */
  remember(location: ReadingLocation) {
    this.location = location;
  }

  async close() {
    const { host } = this;
    const wasEditing = host.section() === 'edit-pdf' && host.inline(),
      location = this.location;
    const page = host.page(),
      revision = host.revision(),
      key = host.activeKey();
    const request = ++this.requests;
    if (wasEditing) this.restoring = true;
    host.setSection(null);
    host.clearArea();
    if (host.tool() !== 'redact') host.setTool('select');
    if (!wasEditing) return;
    host.cancelScrollRestore();
    // Let the reader and its fit zoom recover before positioning the selected page.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (request === this.requests && key === host.activeKey() && revision === host.revision()) {
      if (location && String(revision) === location.revision && page === location.page)
        host.showAt(page, location.top, location.left);
      else host.goToPage(page);
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (request === this.requests) this.restoring = false;
  }

  /** Leaves Editar PDF for an annotation tool. */
  async selectTool(tool: Tool) {
    const { host } = this;
    if (host.draft()) return;
    if (host.section() === 'edit-pdf' && host.inline()) await this.close();
    else host.setSection(null);
    host.setTool(tool);
  }

  async openSection(section: string) {
    const { host } = this;
    if (host.draft()) return;
    if (host.section() === 'edit-pdf' && host.inline()) await this.close();
    host.setSection(section);
  }
}

type PageView = { width: number; height: number; convertToPdfPoint: (x: number, y: number) => number[] };

/** Keyboard and screen-reader access to the area tools: crop keeps most of the page, the
 * others mark a band across its centre. The band is placed as the page is shown (`view`,
 * /Rotate included), then converted to PDF space. */
export function centeredArea(view: PageView, tool: Tool, page: number) {
  const [left, top, right, bottom] = tool === 'crop' ? [0.1, 0.1, 0.9, 0.9] : [0.25, 0.425, 0.75, 0.575];
  const [ax, ay] = view.convertToPdfPoint(view.width * left, view.height * top),
    [bx, by] = view.convertToPdfPoint(view.width * right, view.height * bottom);
  return {
    page,
    rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as [number, number, number, number],
  };
}
