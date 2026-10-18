import { readFlags } from '@career-workspace/core';
import PostsShell from './posts-shell';

export const dynamic = 'force-dynamic';

export default function PostsPage() {
  const publishingEnabled = readFlags(process.env).publishing;
  return <PostsShell enabled={publishingEnabled} />;
}
