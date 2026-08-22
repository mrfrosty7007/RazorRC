import { Compass } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState, Panel } from '@/components/ui';

/** Reached only from a stale deep link or a typo in the address bar. */
export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <Panel>
      <EmptyState
        icon={Compass}
        title="That screen does not exist"
        description="The link may be from an older build of ReviveAI. Everything still works from the dashboard."
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>
        }
      />
    </Panel>
  );
}
