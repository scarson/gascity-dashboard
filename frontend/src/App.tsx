import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AgentsPage } from './routes/Agents';
import { AgentDetailPage } from './routes/AgentDetail';
import { AmbientHomePage } from './routes/AmbientHome';
import { BeadsPage } from './routes/Beads';
import { MailPage } from './routes/Mail';
import { ActivityPage } from './routes/Activity';
import { HealthPage } from './routes/Health';
import { WorkflowsPage } from './routes/Workflows';
import { WorkflowRunDetailPage } from './routes/WorkflowRunDetail';
import { MaintainerPage } from './routes/Maintainer';
import { NowProvider } from './contexts/NowContext';
import { ViewingAsProvider } from './contexts/ViewingAsContext';

export function App() {
  // NowProvider lives at the App root because useFaviconSignal (R8) is
  // mounted inside the L0 ambient home but the favicon swap must persist
  // across routes — a future refactor that mounts the signal on every
  // route stays straightforward because the 1s tick is already global.
  return (
    <ViewingAsProvider>
      <NowProvider>
        <Layout>
          <Routes>
            {/* gascity-dashboard-kb3: / is the L0 ambient home (PRD §4/§5).
                Replaces the pre-kb3 Navigate to /agents. */}
            <Route path="/" element={<AmbientHomePage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:slug" element={<AgentDetailPage />} />
            <Route path="/beads" element={<BeadsPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:workflowId" element={<WorkflowRunDetailPage />} />
            {/* /kanban superseded by /workflows (gascity-dashboard-0t6 + dkb Q3);
                redirect preserved so bookmarks keep working. */}
            <Route path="/kanban" element={<Navigate to="/workflows" replace />} />
            <Route path="/mail" element={<MailPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/maintainer" element={<MaintainerPage />} />
          </Routes>
        </Layout>
      </NowProvider>
    </ViewingAsProvider>
  );
}
