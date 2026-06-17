// Home — renders today's Drop. The DropFeedClient owns the
// trpc.feed.list query + state machine + agree/disagree wiring.

import { DropFeedClient } from '../../components/drop/DropFeedClient';

export default function HomePage(): React.JSX.Element {
  return <DropFeedClient />;
}
