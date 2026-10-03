const { LEAD_STAGES } = require('../../constants/crm');

// Phase 2 workflows ("trigger" text and "actions" with a free-text detail) in the Phase 6 shape.
// Used by migration 003 and by the browser-data importer. They come over paused (D32); what has
// no equivalent is listed in `notes` so the person can finish the rule by hand.
const TRIGGER_MAP = {
  'Lead Created': ['lead.created', {}],
  'Deal Created': ['lead.created', {}],
  'Lead Status Changed to Won': ['lead.stage_changed', { toStages: ['Won'] }],
  'Deal Stage Changed to Won': ['lead.stage_changed', { toStages: ['Won'] }],
  'Deal Stage Changed to Lost': ['lead.stage_changed', { toStages: ['Lost'] }],
  'Task Overdue': ['task.overdue', {}],
  'Customer Added': ['lead.stage_changed', { toStages: ['Won'] }],
};

function convertLegacyWorkflow({ trigger, actions = [] }) {
  const notes = [];
  const [type, params] = TRIGGER_MAP[trigger] || ['lead.created', {}];
  if (!TRIGGER_MAP[trigger]) notes.push(`The old trigger "${trigger}" has no equivalent; it starts on new leads now — check it.`);
  if (trigger === 'Customer Added') notes.push('"Customer Added" became "a lead is won" (that is when a contact becomes a customer).');
  const steps = [];
  for (const action of actions) {
    const detail = String(action?.detail || '').trim();
    switch (action?.type) {
      case 'Create Task':
        steps.push({ type: 'task.create', params: { title: (detail || 'Follow up').slice(0, 300), dueInDays: 1, assignTo: 'owner' } });
        break;
      case 'Notify Agent':
        steps.push({ type: 'agent.notify', params: { to: 'owner', message: (detail || 'Please follow up on {{contact.name}}').slice(0, 500) } });
        break;
      case 'Update Status': {
        const stage = LEAD_STAGES.find((s) => s.toLowerCase() === detail.toLowerCase());
        if (stage && stage !== 'Lost') steps.push({ type: 'stage.change', params: { stage } });
        else notes.push(`"Update Status${detail ? `: ${detail}` : ''}" was left out: choose the stage again.`);
        break;
      }
      case 'Send Email (simulated)':
        notes.push(`"Send Email${detail ? `: ${detail}` : ''}" was left out: the CRM sends WhatsApp messages, not email.`);
        break;
      case 'Add to Sequence':
        notes.push(`"Add to Sequence${detail ? `: ${detail}` : ''}" was left out: add the sequence step again.`);
        break;
      default:
        if (action?.type) notes.push(`"${action.type}" was left out.`);
    }
  }
  return { trigger: { type, params }, steps, notes };
}

module.exports = { convertLegacyWorkflow, TRIGGER_MAP };
