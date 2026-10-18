'use client';
import { useState } from 'react';
import { PostWorkspace } from '../../components/workspace/post-workspace';
import {
  AppShell,
  Button,
  ChatPanel,
  DocumentTable,
  EvidenceTable,
  RoleWorkspace,
  ResumePreview,
  RoleTable,
  Screen,
  Verdict,
  WelcomeCard,
  type ChatMessage,
  type Role,
} from '../../components/workspace';
const roles: Role[] = [
  {
    id: 'northstar',
    title: 'Head of Go-to-Market',
    company: 'Northstar Labs',
    location: 'London',
    score: 9.4,
    reason:
      'Launch and partnership experience; pricing ownership needs confirmation.',
  },
  {
    id: 'fieldnote',
    title: 'Founding Growth Lead',
    company: 'Fieldnote',
    location: 'Remote',
    score: 8,
    reason: 'Hands-on growth work aligns with your goals.',
  },
  {
    id: 'meridian',
    title: 'Director of Partnerships',
    company: 'Meridian',
    location: 'London',
    score: 7.5,
    reason: 'Relevant experience; confirm the team scope.',
  },
  {
    id: 'cedar',
    title: 'Growth Lead',
    company: 'Cedar Works',
    location: 'Manchester',
    score: 5.5,
    reason: 'Several requirements still need evidence.',
  },
];
const evidence = [
  {
    area: 'Building from the beginning',
    assessment: 'Strong connection',
    explanation:
      'Your launch work supports building an early growth programme.',
  },
  {
    area: 'Working across teams',
    assessment: 'Strong connection',
    explanation:
      'Your partnerships work connects sales, marketing and product.',
  },
  {
    area: 'Pricing ownership',
    assessment: 'Needs confirmation',
    explanation: 'Keep it out of your CV until you confirm the experience.',
  },
  {
    area: 'Day-to-day work',
    assessment: 'Personal fit',
    explanation:
      'Consider whether a hands-on role at a small company appeals to you.',
  },
];
export default function DesignSystemPreview() {
  const [view, setView] = useState('home');
  const [role, setRole] = useState(roles[0]);
  const [chat, setChat] = useState(false);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'intro',
      author: 'oppa',
      text: 'You don’t need to tick every box. What feels most uncertain about this role?',
    },
  ]);
  function review(next: Role) {
    setRole(next);
    setView('review');
    setChat(true);
  }
  return (
    <AppShell
      active={
        view === 'posts'
          ? 'posts'
          : view === 'home'
            ? 'home'
            : view === 'documents' || view === 'resume'
              ? 'documents'
              : 'roles'
      }
      onNavigate={(next) => {
        setView(next);
        setChat(false);
      }}
      chat={
        chat ? (
          <ChatPanel
            context={`${role.title} · ${role.company}`}
            messages={messages}
            onClose={() => setChat(false)}
            onSend={(text) =>
              setMessages((previous) => [
                ...previous,
                { id: crypto.randomUUID(), author: 'user', text },
                {
                  id: crypto.randomUUID(),
                  author: 'oppa',
                  text: 'Preview only: your message stays in this page. No AI request has been sent.',
                },
              ])
            }
          />
        ) : undefined
      }
    >
      {view === 'home' && (
        <Screen
          variant="home"
          title="A little closer, every day."
          description="Component preview · fictional roles · changes reset on refresh"
          tools={
            <Button
              onClick={() => {
                setView('posts');
                setChat(false);
              }}
            >
              Posts &amp; credits
            </Button>
          }
        >
          <WelcomeCard
            eyebrow="Your next useful step"
            onContinue={() => review(roles[0])}
          />
          <h2>Top 10 roles</h2>
          <RoleTable roles={roles.slice(0, 10)} onReview={review} />
        </Screen>
      )}
      {view === 'posts' && (
        <Screen
          title="Share your work. Earn credits."
          description="Interactive preview · sample content · no posts sent or credits granted"
          tools={
            <div>
              <Button variant="text" onClick={() => setView('home')}>
                ← Back to my next move
              </Button>
            </div>
          }
        >
          <PostWorkspace />
        </Screen>
      )}
      {view === 'roles' && (
        <Screen
          title="All roles that fit you."
          description="Sample scores out of 10"
          tools={
            <label>
              Search roles{' '}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Role, company or location"
              />
            </label>
          }
        >
          <RoleTable
            roles={roles.filter((r) =>
              `${r.title} ${r.company} ${r.location}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )}
            onReview={review}
          />
        </Screen>
      )}
      {view === 'documents' && (
        <Screen
          title="My documents"
          description="Résumé versions, portfolios and supporting documents"
        >
          <DocumentTable
            documents={[
              {
                id: 'cv',
                name: 'Northstar résumé',
                context: 'Head of Go-to-Market',
                type: 'Résumé',
                version: 'v1 · Sample',
              },
              {
                id: 'portfolio',
                name: 'Project portfolio',
                context: 'Launch and partnership examples',
                type: 'Portfolio',
                version: 'Sample',
              },
            ]}
            onOpen={(doc) => setView(doc.id === 'cv' ? 'resume' : 'portfolio')}
          />
        </Screen>
      )}
      {view === 'portfolio' && (
        <Screen
          title="Project portfolio"
          description="Sample portfolio preview"
        >
          <p>
            Collect confirmed project evidence, your contribution and links to
            the work.
          </p>
          <Button onClick={() => setView('documents')}>
            Back to documents
          </Button>
        </Screen>
      )}
      {view === 'review' && (
        <RoleWorkspace
          role={role}
          stage="review"
          onStage={setView}
          onBack={() => setView('roles')}
          onChat={() => setChat(true)}
          actions={
            <>
              <span role="status">
                {saved.includes(role.id)
                  ? 'Saved for later · this preview only'
                  : 'You choose what deserves your energy.'}
              </span>
              <Button
                onClick={() =>
                  setSaved((previous) =>
                    previous.includes(role.id)
                      ? previous
                      : [...previous, role.id],
                  )
                }
              >
                {saved.includes(role.id) ? 'Saved for later' : 'Save for later'}
              </Button>
              <Button variant="primary" onClick={() => setView('resume')}>
                Pursue & prepare my CV →
              </Button>
            </>
          }
        >
          <Verdict
            title={
              role.id === 'northstar'
                ? 'Worth your time. With one thing to check.'
                : 'Let’s check the evidence behind this fit.'
            }
          >
            {role.reason}
          </Verdict>
          <h2>The story behind the fit</h2>
          <EvidenceTable
            rows={
              role.id === 'northstar'
                ? evidence
                : [
                    {
                      area: 'Role requirements',
                      assessment: 'Needs review',
                      explanation: role.reason,
                    },
                  ]
            }
          />
        </RoleWorkspace>
      )}
      {view === 'resume' && (
        <RoleWorkspace
          role={role}
          stage="resume"
          onStage={setView}
          onBack={() => setView('roles')}
          onChat={() => setChat(true)}
          actions={
            <>
              <span>Fictional sample · check every claim.</span>
              <Button onClick={() => setView('review')}>Back to fit</Button>
              <Button variant="primary" onClick={() => setView('track')}>
                Track progress →
              </Button>
            </>
          }
        >
          <ResumePreview pdfUrl="/demo/output/pdf/career-oppa-sample-cv.pdf">
            <h2>Alex Morgan</h2>
            <p>Go-to-market & growth leader</p>
            <h3>Profile</h3>
            <p>
              Growth leader connecting customer insight, partnerships and
              product launches.
            </p>
            <h3>Experience</h3>
            {Array.from({ length: 6 }, (_, i) => (
              <p key={i}>
                Sample project {i + 1}: coordinated launch plans and worked
                across commercial and product teams. Replace with confirmed
                candidate evidence.
              </p>
            ))}
          </ResumePreview>
        </RoleWorkspace>
      )}
      {view === 'track' && (
        <RoleWorkspace
          role={role}
          stage="track"
          onStage={setView}
          onBack={() => setView('roles')}
          onChat={() => setChat(true)}
          actions={
            <>
              <span>Sample progress · nothing submitted</span>
              <Button onClick={() => setView('resume')}>
                Back to preparation
              </Button>
            </>
          }
        >
          <h2>Your next step</h2>
          <p>
            Review your application materials, then apply on the employer’s
            website. No application has been sent from this preview.
          </p>
        </RoleWorkspace>
      )}
    </AppShell>
  );
}
