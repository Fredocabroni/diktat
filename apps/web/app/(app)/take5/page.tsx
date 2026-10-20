// Take 5 — archive stack for days when the user wants more than
// today's one Drop (and the fallback surface when the heat score
// skips a day). P4 PR B. The Take5StackClient owns trpc.take5.getStack
// + recordShift wiring and the done / empty states.

import { Take5StackClient } from '../../../components/take5/Take5StackClient';

export default function Take5Page(): React.JSX.Element {
  return (
    <section className="mx-auto max-w-md px-4 py-6">
      <Take5StackClient />
    </section>
  );
}
