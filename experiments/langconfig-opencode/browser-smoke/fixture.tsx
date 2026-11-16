import React from 'react';
import { createRoot } from 'react-dom/client';
import NodeConfigPanel from '@/features/workflows/node-config/NodeConfigPanel';

const selectedNode = {
  id: 'fixture-review-node', agentType: 'TOOL_NODE', model: '', system_prompt: '',
  temperature: 0, tools: [], native_tools: [],
};

createRoot(document.getElementById('root')!).render(
  <NodeConfigPanel selectedNode={selectedNode} onClose={() => {}} onSave={(nodeId, config) => {
    document.getElementById('saved')!.textContent = JSON.stringify({ nodeId, config });
  }} />,
);
