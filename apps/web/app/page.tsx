import MobileNavigation from './mobile-navigation';
import { FounderLink } from './founder-link';

function SignInLink({ light = false }: { light?: boolean }) {
  return <a className={`button ${light ? 'button-light' : 'button-primary'}`} href="/sign-in">Sign in<span aria-hidden="true">↗</span></a>;
}

function Brand() {
  return <span className="brand">career<span>-oppa</span><span className="brand-dot" aria-hidden="true" /></span>;
}

const questions = [
  ['Is this for me if I’m just starting out?', 'Yes. Career-Oppa is being built for students and people early in their careers, aged 18 or over. Coursework, volunteering, side projects and part-time jobs can all give you something useful to talk about. We’ll help you look for it.'],
  ['When can I give it a try?', 'The pilot is open to invited students. Sign in with the Google account your invite was sent to. If you’d like an invite, talk to the founder. We’d love to hear what you’re working towards.'],
  ['Will my CV still sound like me?', 'That’s the aim. We’re building it around experience you’ve checked and approved. You’ll see the original details beside suggested wording, so you can make sure it says what you mean. You’ll always get the final say.'],
  ['Will Oppa apply for me?', 'You’ll choose the roles and send the applications. Oppa will help you think through the fit, prepare your CV and get your words together. We want you to feel comfortable with everything that goes out in your name.'],
  ['Will I need to pay?', 'We’re planning 30 free credits each month. A role review will use 1 credit and a tailored CV will use 3. If you need more, optional packs are planned from $5 for 100 credits (charged in US dollars). Free credits refresh each month; purchased credits won’t expire. We’ll confirm prices before launch.'],
  ['Can you promise I’ll get an interview?', 'We can’t promise what an employer will decide. We’re here to help you understand your options, prepare thoughtfully and talk about your experience with more confidence. A rejection doesn’t erase the work you’ve put in.'],
];

export default function Home() {
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header">
      <div className="container nav-row">
        <a href="#" aria-label="Career-Oppa home"><Brand /></a>
        <nav className="desktop-nav" aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#workspace">The workspace</a><a href="#credits">Credits</a></nav>
        <div className="nav-actions"><SignInLink /></div>
        <MobileNavigation />
      </div>
    </header>
    <main id="main">
      <section className="hero container">
        <div className="hero-copy">
          <p className="audience"><span className="little-star" aria-hidden="true">✳</span> For your first job, and the steps after it.</p>
          <h1>You’ve got a lot<br />to offer. Let’s<br />help them see it.</h1>
          <p className="hero-description">Starting your career can feel like a lot to figure out on your own. Let’s find the roles that make sense for you, bring out your strengths, and work on your next application together.</p>
          <div className="hero-actions"><SignInLink /><a className="quiet-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a></div>
          <p className="fine-print">The pilot is open to invited students. We’re glad you’re here.</p>
        </div>
        <div className="hero-scene" role="group" aria-label="Illustration of Oppa alongside a sample role review">
          <div className="scene-caption">A little closer, every day.</div>
          <div className="orbit" aria-hidden="true" /><span className="scene-star" aria-hidden="true">✳</span>
          <div className="coach-bubble">“That project you keep playing down?<br />Let’s talk about what you did.”</div>
          <img className="hero-character" src="/assets/career-oppa-character-adult.png" alt="Oppa, the illustrated career coach, in a blue jacket" width="1145" height="1374" fetchPriority="high" />
          <div className="fit-note"><div className="note-top"><span className="company-icon">n.</span><div><strong>Graduate Marketing Associate</strong><span>Northstar · Sample role</span></div></div><div className="note-bottom"><span className="fit-tag">Worth a closer look</span><span className="note-check" aria-hidden="true">✓</span></div></div>
          <div className="scene-footer"><span className="online-dot" /> Meet Oppa. An AI career coach in your corner.</div>
        </div>
      </section>

      <div className="promise-strip"><div className="container"><span>Your experience counts.</span><span>Your questions are welcome.</span><span>We’ll take it one step at a time.</span></div></div>

      <section className="section container problem">
        <div><p className="section-kicker">It’s okay to feel a little stuck.</p><h2>You don’t have to<br />figure it all out<br />today.</h2></div>
        <div className="problem-copy"><p>You’ve saved a few roles, rewritten your CV, and wondered whether you have enough experience. It’s tiring to put in that effort and still feel unsure.</p><p>Let’s start with what you’ve already done. A class project, a part-time job, the society you helped run. We’re building Career-Oppa to help you see how that experience fits a role, and put it into words you feel good about.</p><span className="handwritten-note">Let’s start with one role you care about.</span></div>
      </section>

      <section className="how-section" id="how-it-works"><div className="container section">
        <div className="section-intro"><div><p className="section-kicker">Here’s how we’ll work through it</p><h2>Bring what you have.<br />We’ll start there.</h2></div><p>You don’t need a polished CV to begin. Here’s how we’re building a little more support into each step.</p></div>
        <div className="steps">
          <article><span className="step-number">01</span><h3>Tell us what you’ve done.</h3><p>Bring your CV, projects, coursework or work experience. We’ll help you gather the useful details, and you’ll check that we’ve got them right.</p><div className="step-example"><span className="mini-icon pink">✓</span><div><strong>Student society campaign</strong><small>Experience you confirmed</small></div></div></article>
          <article><span className="step-number">02</span><h3>Let’s look at that role together.</h3><p>Share a job link or description. We’ll look at where you fit, be honest about the gaps, and help you decide whether it’s worth your time.</p><div className="step-example fit-example"><span>Strengths</span><span>Gaps</span><span>Unknowns</span></div></article>
          <article><span className="step-number">03</span><h3>Help them see what you bring.</h3><p>We’ll help you shape your CV and answers around the role. You’ll have somewhere to practise, prepare a message, and keep track of what comes next.</p><div className="step-example"><span className="mini-icon blue">↗</span><div><strong>Your next step</strong><small>Review the opening of your CV</small></div></div></article>
        </div>
      </div></section>

      <section className="section container" id="workspace">
        <div className="section-intro"><div><p className="section-kicker">A place to come back to</p><h2>Pick up where<br />you left off.</h2></div><p>Your roles, CVs and next steps will stay together. When you’re ready to come back, you’ll know where to start.</p></div>
        <div className="workspace-preview">
          <div className="preview-top"><Brand /><span>Example workspace</span><span className="avatar">J</span></div>
          <div className="preview-body"><div className="preview-main"><div className="preview-heading"><div><p>Your next chapter</p><h3>A little closer, every day.</h3></div><span className="small-button">A look at what’s coming</span></div>
            <div className="preview-banner"><div><span>Your next useful step</span><h4>Let’s finish your Northstar application.</h4><p>You’ve done the work. Let’s help you talk about it.</p></div><span className="banner-spark" aria-hidden="true">✳</span></div>
            <div className="roles-heading"><strong>The roles on your mind</strong><span>Sample data</span></div>
            <div className="role-row"><span className="company-icon">n.</span><div><strong>Graduate Marketing Associate</strong><small>Northstar · London</small></div><span className="status green">Review your fit</span></div>
            <div className="role-row"><span className="company-icon plum">p.</span><div><strong>Junior Product Analyst</strong><small>Plum · Remote</small></div><span className="status yellow">Preparing CV</span></div>
            <div className="role-row"><span className="company-icon purple">s.</span><div><strong>Partnerships Intern</strong><small>Studio · Manchester</small></div><span className="status gray">Saved for later</span></div>
          </div><aside className="preview-coach"><div className="coach-label"><img src="/assets/career-oppa-character-adult.png" alt="" width="38" height="46" /><div><strong>Oppa</strong><small>Your career coach</small></div></div><p>Don’t skip over that society campaign. There’s useful experience there.</p><p>Tell me which part you took on. What did you try, and what did you learn?</p><div className="sample-prompt">Help me tell that story</div><span className="sample-caption">Illustrative conversation</span></aside></div>
        </div>
        <p className="preview-footnote">A look at the workspace we’re building, with sample roles and conversations.</p>
        <div className="feature-grid">
          <article><span className="feature-symbol pink" aria-hidden="true">↗</span><h3>A CV that sounds like you.</h3><p>That project deserves more than a line at the bottom. We’ll help you explain what you did and why it matters for this role. You check every word before exporting.</p></article>
          <article><span className="feature-symbol yellow" aria-hidden="true">@</span><h3>A little help saying hello.</h3><p>Reaching out can feel awkward. We’ll help you find relevant people, see where their details came from, and draft a message you’re comfortable sending.</p></article>
          <article><span className="feature-symbol green" aria-hidden="true">“</span><h3>Some practice before the nerves.</h3><p>Work through interview questions in writing, with feedback along the way. You can take your time, try again, and find the words that feel like yours.</p></article>
        </div>
      </section>

      <section className="coach-section"><div className="container coach-layout"><div className="coach-portrait"><div className="portrait-circle" /><img src="/assets/career-oppa-character-adult.png" alt="Oppa, your illustrated career coach" width="1145" height="1374" loading="lazy" /></div><div className="coach-copy"><p className="section-kicker">Meet your career Oppa</p><h2>Rooting for you.<br />Honest with you.</h2><p>Think of the older brother who asks how the application’s going, listens when you’re stuck, and helps you give it another go. That’s the kind of support we’re building into Oppa, your AI career coach.</p><p>He’ll help you spot the experience you’ve overlooked and talk through what needs work. Bring the question you think you should already know the answer to. It’s welcome here.</p><div className="coach-principle"><span aria-hidden="true">✓</span><div><strong>It’s your career. You get the final say.</strong><p>Oppa helps you think it through. You decide what feels right and what to send.</p></div></div><SignInLink /></div></div></section>

      <section className="section container credits-section" id="credits"><div className="credits-copy"><p className="section-kicker">A bit of breathing room</p><h2>Your first steps <br />shouldn’t need <br />a subscription.</h2><p>You’ve got enough to think about while looking for work. We’re planning free credits each month so you can get some help, with optional packs if you need more.</p><p className="fine-print">Planned pricing · Subject to change before launch</p></div><div className="credit-card"><div className="credit-card-heading"><span>Monthly free allowance</span><span className="credit-star" aria-hidden="true">✳</span></div><div className="credit-total">30 <span>credits / month</span></div><p>Use them wherever you could use a hand.</p><div className="credit-cost"><span>A closer look at a role</span><strong>1 credit</strong></div><div className="credit-cost"><span>A tailored CV</span><strong>3 credits</strong></div><div className="credit-cost"><span>An interview practice session</span><strong>3 credits</strong></div><p className="credit-pack">Need more? Planned packs start at <strong>$5 for 100 credits.</strong> Charged in US dollars. Purchased credits won’t expire.</p><a className="quiet-link" href="#questions">More about credits <span aria-hidden="true">↓</span></a></div></section>

      <section className="section container faq-section" id="questions"><div><p className="section-kicker">You might be wondering</p><h2>Good questions.<br />Let’s talk about them.</h2></div><div className="faq-list">{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>

      <section className="closing" id="pilot"><div className="container closing-inner"><span className="closing-star" aria-hidden="true">✳</span><p>We’re looking forward to seeing where you go.</p><h2>Let’s take that<br />next step together.</h2><p className="pilot-intro">Invited to the pilot? Sign in with the Google account <br />your invite was sent to. We’re glad you’re here.</p><SignInLink light /><div className="founder-invite"><h3>Would you like an invite?</h3><p>Talk to the founder about what you’re working towards <br />and where a little support would help.</p><FounderLink /></div></div></section>
    </main>
    <footer className="container footer"><div><a href="#" aria-label="Career-Oppa home"><Brand /></a><p>A little closer, every day.</p></div><nav aria-label="Footer navigation"><a href="#how-it-works">How it works</a><a href="#credits">Credits</a><a href="#questions">Questions</a><SignInLink /></nav><div className="footer-bottom"><span>© {new Date().getFullYear()} Career-Oppa</span><span>Invite-only student pilot.</span></div></footer>
  </>;
}
