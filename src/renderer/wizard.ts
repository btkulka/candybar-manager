/**
 * Lightweight swimlane wizard controller.
 *
 * A wizard is a vertical stack of numbered lanes. Each lane is in one of three states:
 *   - locked: dimmed single-row strip, title only
 *   - active: full content visible
 *   - done:   collapsed one-line summary strip with an "Edit" button
 *
 * The controller owns the transitions; the host page owns the lane content and
 * decides what summary text to show when a lane finishes.
 */

export type LaneState = 'locked' | 'active' | 'done';

export interface LaneSummary {
  text: string;
  detail?: string;
}

export interface LaneOptions {
  /** Called when the user clicks Edit on a done lane. The host should re-activate
   *  the lane (via setActive) and reset any later lanes it wants to invalidate. */
  onEdit?: () => void;
}

export class Wizard {
  readonly root: HTMLElement;
  private lanes: Map<string, Lane> = new Map();
  private order: string[] = [];

  constructor(rootId: string) {
    const el = document.getElementById(rootId);
    if (!el) throw new Error(`[Wizard] root #${rootId} not found`);
    this.root = el;
    this.root.classList.add('wizard');
    this.collect();
  }

  private collect() {
    const laneEls = Array.from(this.root.querySelectorAll<HTMLElement>('[data-lane]'));
    this.order = [];
    laneEls.forEach((laneEl, idx) => {
      const id = laneEl.dataset.lane!;
      const lane = new Lane(laneEl, idx + 1);
      this.lanes.set(id, lane);
      this.order.push(id);
    });
  }

  get(id: string): Lane {
    const lane = this.lanes.get(id);
    if (!lane) throw new Error(`[Wizard] unknown lane: ${id}`);
    return lane;
  }

  configure(id: string, options: LaneOptions) {
    this.get(id).configure(options);
  }

  /** Activate `id`. Later lanes become locked; earlier lanes stay in their current
   *  state (typically `done`, but if user is stepping back to an earlier lane we
   *  leave prior completions intact). */
  setActive(id: string) {
    const targetIdx = this.order.indexOf(id);
    if (targetIdx < 0) return;
    this.order.forEach((laneId, idx) => {
      const lane = this.get(laneId);
      if (idx === targetIdx) {
        lane.setState('active');
      } else if (idx > targetIdx) {
        lane.setState('locked');
        lane.clearSummary();
      }
      // idx < targetIdx: leave as-is (done or active — don't clobber prior summary)
    });
  }

  /** Mark a lane done and set its summary. Does not change any other lane. */
  setDone(id: string, summary: LaneSummary) {
    this.get(id).setDone(summary);
  }

  /** Reset every lane: first is active, rest are locked. */
  reset() {
    this.order.forEach((laneId, idx) => {
      const lane = this.get(laneId);
      lane.clearSummary();
      lane.setState(idx === 0 ? 'active' : 'locked');
    });
  }

  /** Reset all lanes after the given lane to `locked` (useful when user edits an
   *  earlier step and we want to invalidate downstream progress). */
  invalidateAfter(id: string) {
    const idx = this.order.indexOf(id);
    if (idx < 0) return;
    for (let i = idx + 1; i < this.order.length; i++) {
      const lane = this.get(this.order[i]);
      lane.clearSummary();
      lane.setState('locked');
    }
  }
}

class Lane {
  readonly el: HTMLElement;
  private summaryEl: HTMLElement;
  private summaryTextEl: HTMLElement;
  private summaryDetailEl: HTMLElement | null;
  private editBtn: HTMLButtonElement;
  private options: LaneOptions = {};

  constructor(el: HTMLElement, index: number) {
    this.el = el;

    // Ensure structural scaffolding exists. Host HTML should already provide:
    //   .lane-index, .lane-body > .lane-header, .lane-content
    // We inject .lane-summary and wire the edit button.
    const body = el.querySelector<HTMLElement>('.lane-body');
    if (!body) throw new Error(`[Wizard] lane ${el.dataset.lane} missing .lane-body`);

    // Numbered index badge
    let indexEl = el.querySelector<HTMLElement>('.lane-index');
    if (!indexEl) {
      indexEl = document.createElement('div');
      indexEl.className = 'lane-index';
      el.prepend(indexEl);
    }
    indexEl.textContent = String(index);

    // Summary strip (injected once, hidden unless state=done)
    let summary = body.querySelector<HTMLElement>(':scope > .lane-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'lane-summary';
      summary.innerHTML = `
        <span class="lane-summary-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        <span class="lane-summary-text"></span>
        <span class="lane-summary-detail"></span>
        <button type="button" class="btn-ghost btn-sm lane-edit-btn" data-tooltip="Edit this step">Edit</button>
      `;
      // Insert after header, before content
      const header = body.querySelector<HTMLElement>('.lane-header');
      if (header && header.nextSibling) body.insertBefore(summary, header.nextSibling);
      else body.prepend(summary);
    }
    this.summaryEl = summary;
    this.summaryTextEl = summary.querySelector<HTMLElement>('.lane-summary-text')!;
    this.summaryDetailEl = summary.querySelector<HTMLElement>('.lane-summary-detail');
    this.editBtn = summary.querySelector<HTMLButtonElement>('.lane-edit-btn')!;
    this.editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.onEdit?.();
    });

    // Default state
    if (!el.dataset.state) el.dataset.state = 'locked';
  }

  configure(options: LaneOptions) {
    this.options = { ...this.options, ...options };
  }

  get state(): LaneState {
    return (this.el.dataset.state as LaneState) || 'locked';
  }

  setState(state: LaneState) {
    this.el.dataset.state = state;
  }

  setDone(summary: LaneSummary) {
    this.summaryTextEl.textContent = summary.text;
    if (this.summaryDetailEl) {
      this.summaryDetailEl.textContent = summary.detail ?? '';
      this.summaryDetailEl.style.display = summary.detail ? '' : 'none';
    }
    this.setState('done');
  }

  clearSummary() {
    this.summaryTextEl.textContent = '';
    if (this.summaryDetailEl) {
      this.summaryDetailEl.textContent = '';
      this.summaryDetailEl.style.display = 'none';
    }
  }
}
