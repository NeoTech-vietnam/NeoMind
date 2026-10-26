import {
  createCornellNote,
  reviseCornellNote,
  validateCornellNote,
  type CornellInput,
} from './notes.js';
import {
  listRecipes,
  prepareRecipe,
  resolveRecipe,
  reviseRecipe,
  runRecipe,
  type RecipeInput,
} from './recipes.js';
import { describeCapabilities, invokeCapability, resolveCapabilities } from './tools.js';
import {
  discoverProjectKnowledge,
  recordKnowledgeResearch,
  searchProjectKnowledge,
  type KnowledgeResearchInput,
  type KnowledgeSearchInput,
} from './knowledge-reuse.js';
import { publishProjectKnowledge } from './project-knowledge.js';

/**
 * Internal CLI dispatcher; the caller parses --data and forwards --upstream in options.
 * Knowledge input can instead be positional JSON; --json remains the caller's output flag.
 */
export async function dispatchKnowledgeCommand(
  root: string,
  group: string,
  command: string | undefined,
  args: string[],
  data: Record<string, unknown> = {},
  options: { upstream?: string } = {},
): Promise<{ handled: boolean; result?: unknown }> {
  const id = args[0];
  if (group === 'knowledge') {
    const input = (position: number): Record<string, unknown> => {
      if (args.length > position + 1)
        throw new Error('Supply one knowledge JSON object, quoted as a single argument.');
      if (args[position] === undefined) return data;
      if (Object.keys(data).length)
        throw new Error('Supply knowledge input as positional JSON or --data, not both.');
      const value: unknown = JSON.parse(args[position]);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Knowledge input must be a JSON object.');
      return value as Record<string, unknown>;
    };
    if (command === 'discover')
      return {
        handled: true,
        result: discoverProjectKnowledge(
          root,
          input(0) as unknown as KnowledgeSearchInput & { repository?: string },
        ),
      };
    if (command === 'search')
      return {
        handled: true,
        result: searchProjectKnowledge(root, input(0) as unknown as KnowledgeSearchInput),
      };
    if (command === 'research' && id?.trim())
      return {
        handled: true,
        result: recordKnowledgeResearch(root, id, input(1) as unknown as KnowledgeResearchInput),
      };
    if (command === 'publish' && id?.trim()) {
      if (args.length !== 1 || typeof options.upstream !== 'string' || !options.upstream.trim())
        throw new Error('Use knowledge publish CANDIDATE --upstream OWNER/REPO.');
      return { handled: true, result: publishProjectKnowledge(root, id, options.upstream) };
    }
    throw new Error(
      'Use knowledge discover|search --data JSON, knowledge research WORKFLOW --data JSON, or knowledge publish CANDIDATE --upstream OWNER/REPO.',
    );
  }
  if (group === 'note' || group === 'cornell' && ['create', 'revise', 'validate'].includes(command ?? '')) {
    if (command === 'create')
      return { handled: true, result: createCornellNote(root, data as unknown as CornellInput) };
    if (command === 'validate' && id)
      return { handled: true, result: validateCornellNote(root, id) };
    if (command === 'revise' && id)
      return {
        handled: true,
        result: reviseCornellNote(
          root,
          id,
          data.note as CornellInput,
          Number(data.expected_revision),
          String(data.revision_reason ?? ''),
        ),
      };
    throw new Error(
      'Use note create --data JSON, note revise ID --data JSON, or note validate KNOWLEDGE_ID.',
    );
  }
  if (group === 'recipe') {
    if (command === 'list') return { handled: true, result: listRecipes() };
    if (command === 'resolve' && id)
      return {
        handled: true,
        result: resolveRecipe(id, typeof data.version === 'string' ? data.version : undefined),
      };
    if (command === 'prepare')
      return { handled: true, result: prepareRecipe(root, data as unknown as RecipeInput) };
    if (command === 'run' && id)
      return {
        handled: true,
        result: runRecipe(
          root,
          id,
          typeof data.invocation_id === 'string' ? data.invocation_id : undefined,
        ),
      };
    if (command === 'revise' && id)
      return {
        handled: true,
        result: reviseRecipe(root, id, data as unknown as Parameters<typeof reviseRecipe>[2]),
      };
    throw new Error('Use recipe list|resolve ID|prepare --data JSON|run ID|revise ID --data JSON.');
  }
  if (group === 'capability' || group === 'tool') {
    if (command === 'describe')
      return {
        handled: true,
        result: describeCapabilities(root, String(data.role ?? id ?? 'manager')),
      };
    if (command === 'resolve')
      return {
        handled: true,
        result: await resolveCapabilities(
          root,
          data as unknown as Parameters<typeof resolveCapabilities>[1],
        ),
      };
    if (command === 'invoke')
      return {
        handled: true,
        result: await invokeCapability(
          root,
          data as unknown as Parameters<typeof invokeCapability>[1],
        ),
      };
    throw new Error('Use capability describe ROLE|resolve --data JSON|invoke --data JSON.');
  }
  return { handled: false };
}
