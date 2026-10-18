'use client';

import { useRef } from 'react';

export default function MobileNavigation() {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  return <details ref={menu} className="mobile-menu" onKeyDown={event => { if (event.key === 'Escape') { close(); menu.current?.querySelector('summary')?.focus(); } }}>
    <summary aria-label="Open navigation"><span /><span /></summary>
    <nav aria-label="Mobile navigation">
      <a href="#how-it-works" onClick={close}>How it works</a>
      <a href="#workspace" onClick={close}>The workspace</a>
      <a href="#credits" onClick={close}>Credits</a>
      <a href="#questions" onClick={close}>Questions</a>
      <a className="button button-primary" href="/sign-in" onClick={close}>Sign in</a>
    </nav>
  </details>;
}
