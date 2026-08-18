/**
 * KAR-24.2 AC4 — the library's own accessibility contract, verified once
 * against the primitives rather than re-verified per screen.
 *
 * Verifies: EPIC-24-S07
 *
 * `docs/12-frontend-architecture.md` §9.3 credits Reka UI for focus trap,
 * `Esc`, outside-click, `aria-modal` and focus return on `UiModal`, and says
 * not to reimplement any of it — this file is the proof that the wiring
 * actually delivers what that credit assumes, not a re-test of Reka UI
 * itself. Everything else here (the switch's keyboard activation, the
 * field's label association, the two progress roles, the focus ring) is
 * plain DOM behaviour this library owns outright and has to keep owning.
 *
 * Real Chromium rather than jsdom, for the same reason `StateChip.test.ts`
 * gives: `:focus-visible` and outline computed style only resolve against a
 * real cascade, and `Tab` only moves focus through a real focus order.
 */
import { expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-vue';
import { defineComponent, h, ref } from 'vue';
import '../../styles/theme.css';
import { UiButton, UiField, UiMeter, UiModal, UiProgressSplit, UiToggle } from './index.ts';

suite(
  'EPIC-24-S07 — UiModal traps focus, closes on Escape and outside click, returns it on close (AC4)',
  () => {
    /**
     * A real opener button plus the modal, so "focus returns to the element
     * that opened it" has an element to return to and "Tab past the last
     * control stays inside" has more than one focusable thing to escape past.
     */
    const Harness = defineComponent({
      props: { open: { type: Boolean, required: true } },
      emits: ['close'],
      setup(props, { emit, expose }) {
        const openerRef = ref<HTMLButtonElement>();
        expose({ openerRef });
        return () =>
          h('div', [
            h('button', { type: 'button', ref: openerRef, onClick: () => emit('close') }, 'Open'),
            h(
              UiModal,
              { open: props.open, title: 'Confirm run', onClose: () => emit('close') },
              {
                default: () => [
                  h('button', { type: 'button' }, 'First'),
                  h('button', { type: 'button' }, 'Last'),
                ],
              },
            ),
          ]);
      },
    });

    it('carries aria-modal and is labelled by its title', async () => {
      render(Harness, { props: { open: true } });

      await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog.getAttribute('aria-modal')).toBe('true');

      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).not.toBeNull();
      const title = document.getElementById(labelledBy as string);
      expect(title?.textContent?.trim()).toBe('Confirm run');
    });

    it('keeps Tab past the last control inside the dialog', async () => {
      render(Harness, { props: { open: true } });

      await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
      const last = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Last',
      ) as HTMLElement;
      last.focus();
      await userEvent.tab();

      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('closes on Escape', async () => {
      const screen = render(Harness, { props: { open: true } });

      await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
      await userEvent.keyboard('{Escape}');

      expect(screen.emitted().close).toBeTruthy();
    });

    it('closes on an outside click', async () => {
      const screen = render(Harness, { props: { open: true } });

      await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
      // The overlay covers the whole viewport and grid-centres the panel inside
      // it, so a click at the overlay's own centre lands on the panel that sits
      // on top of it there — a click near a corner is what actually lands on
      // the backdrop, which is what a real outside click looks like.
      const overlay = document.querySelector('.ui-modal__overlay') as HTMLElement;
      await userEvent.click(overlay, { position: { x: 4, y: 4 } });

      await expect.poll(() => screen.emitted().close).toBeTruthy();
    });

    it('returns focus to the element that opened it once closed', async () => {
      const screen = render(Harness, { props: { open: true } });

      const opener = screen.container.querySelector('button') as HTMLElement;
      opener.focus();
      expect(document.activeElement).toBe(opener);

      await screen.rerender({ open: false });

      await expect.poll(() => document.activeElement).toBe(opener);
    });
  },
);

suite('EPIC-24-S07 — UiToggle is a real switch (AC4)', () => {
  it('exposes role="switch" and aria-checked, and flips on click', async () => {
    const screen = render(UiToggle, { props: { modelValue: false, label: 'Runtime enabled' } });

    const toggle = screen.getByRole('switch');
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();

    expect(screen.emitted()['update:modelValue']).toEqual([[true]]);
  });

  it('flips on Space and on Enter', async () => {
    const onUpdate = (next: boolean) => {
      calls.push(next);
    };
    const calls: boolean[] = [];
    const Harness = defineComponent({
      setup() {
        const value = ref(false);
        return () =>
          h(UiToggle, {
            modelValue: value.value,
            label: 'Require approval',
            'onUpdate:modelValue': (next: boolean) => {
              value.value = next;
              onUpdate(next);
            },
          });
      },
    });

    const screen = render(Harness);
    const toggle = screen.getByRole('switch');
    (toggle.element() as HTMLElement).focus();

    await userEvent.keyboard(' ');
    expect(calls).toEqual([true]);

    await userEvent.keyboard('{Enter}');
    expect(calls).toEqual([true, false]);
  });
});

suite('EPIC-24-S07 — UiField associates its label with its input (AC4)', () => {
  it('focuses the input when the label is clicked', async () => {
    const screen = render(UiField, { props: { label: 'Run name', modelValue: '' } });

    const label = screen.container.querySelector('label') as HTMLElement;
    const input = screen.container.querySelector('input') as HTMLInputElement;

    expect(label.getAttribute('for')).toBe(input.id);

    await userEvent.click(label);
    expect(document.activeElement).toBe(input);
  });
});

suite('EPIC-24-S07 — UiMeter and UiProgressSplit expose role="progressbar" (AC4)', () => {
  it('UiMeter carries the value triad and a caller-supplied label', async () => {
    const screen = render(UiMeter, { props: { pct: 42, ariaLabel: 'Node progress' } });

    const bar = screen.getByRole('progressbar');
    await expect.element(bar).toHaveAttribute('aria-valuenow', '42');
    await expect.element(bar).toHaveAttribute('aria-valuemin', '0');
    await expect.element(bar).toHaveAttribute('aria-valuemax', '100');
    await expect.element(bar).toHaveAttribute('aria-label', 'Node progress');
  });

  it('UiProgressSplit exposes the done fraction plus an aria-valuetext for the running fraction', async () => {
    const screen = render(UiProgressSplit, { props: { done: 3, running: 2, total: 10 } });

    const bar = screen.getByRole('progressbar');
    await expect.element(bar).toHaveAttribute('aria-valuenow', '30');
    await expect.element(bar).toHaveAttribute('aria-valuemin', '0');
    await expect.element(bar).toHaveAttribute('aria-valuemax', '100');
    await expect.element(bar).toHaveAttribute('aria-valuetext', '3 of 10 done, 2 running');
  });
});

suite('EPIC-24-S07 — nothing in ui/ removes a focus outline (AC4)', () => {
  it('a focused UiButton resolves a real, non-none outline style', async () => {
    const Harness = defineComponent({
      setup() {
        return () =>
          h('div', [h('button', { type: 'button' }, 'Before'), h(UiButton, {}, () => 'Retry')]);
      },
    });
    render(Harness);

    // Tabbed to rather than `.focus()`-ed directly: `:focus-visible` is a
    // heuristic keyed on *how* focus arrived, and a programmatic `.focus()`
    // call after this suite's earlier pointer interactions is exactly the
    // case Chromium does not treat as visible. Real sequential keyboard
    // navigation is what the ring is actually for, so that is what earns it
    // here — the same approach `app/keyboard.test.ts`'s `expectRing` uses.
    await userEvent.tab();
    await userEvent.tab();

    const button = document.activeElement as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Retry');

    const style = getComputedStyle(button);
    // `outline-style` rather than `outline`, because the shorthand's computed
    // value composes colour/width/style, and it is specifically the style
    // keyword that `outline: none` would zero out.
    expect(style.outlineStyle).not.toBe('none');
    expect(style.outlineStyle).not.toBe('');
  });
});
