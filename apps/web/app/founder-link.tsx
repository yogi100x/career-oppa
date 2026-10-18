const founderUrl = process.env.FOUNDER_CONTACT_URL;

function contactUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function FounderLink() {
  const href = contactUrl(founderUrl);
  return href ? <a className="founder-link" href={href}>Talk to the founder <span aria-hidden="true">↗</span></a>
    : <><button className="founder-link" type="button" disabled aria-describedby="founder-status">Talk to the founder</button><span id="founder-status" className="contact-status">Founder contact is unavailable here.</span></>;
}
