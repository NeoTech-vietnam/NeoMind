import type { Profile } from './schema.js';

/**
 * Starting points for a new agent (profile). They live in code, not in the project, so a template change never alters
 * an existing profile: creating from a template copies it into an ordinary draft the user then owns.
 */
export type ProfileTemplate = {
  label: string; description: string; instructions: string; requestedPermissions: Profile['requestedPermissions'];
  /** Skill IDs worth pinning when the project has them; missing ones are simply not pinned. */
  suggestedSkills: string[];
  /** Read-only templates suit review_group reviewers, which may not write or commit. */
  reviewer: boolean;
};

const readOnly = { read: true, write: false, checks: true, gitCommit: false };
export const profileTemplates = {
  implementer: { label: 'Implementer', description: 'Lập kế hoạch ngắn rồi sửa code trong phạm vi được duyệt.', reviewer: false, suggestedSkills: [],
    requestedPermissions: { read: true, write: true, checks: true, gitCommit: false },
    instructions: 'Survey the project, propose a concise plan, and implement only approved changes. Preserve existing work. Use the specified checks.' },
  planner: { label: 'Planner', description: 'Đọc code và đề xuất kế hoạch có tiêu chí nghiệm thu; không sửa file.', reviewer: false, suggestedSkills: [],
    requestedPermissions: readOnly,
    instructions: 'Read the relevant code before planning. Propose the smallest plan that meets the task: numbered steps, files in scope, acceptance criteria a reviewer can check, and the checks to run. Do not edit files.' },
  reviewer: { label: 'Reviewer độc lập', description: 'Đánh giá kết quả so với yêu cầu và kế hoạch, có bằng chứng.', reviewer: true, suggestedSkills: ['review-checklist'],
    requestedPermissions: readOnly,
    instructions: 'Evaluate the original task and approved plan independently. Read source and checks before forming a verdict. Cite exact evidence. Report uncertainty.' },
  'ui-reviewer': { label: 'Reviewer UI', description: 'Review giao diện: trạng thái, khả năng truy cập, sáng/tối, màn hẹp.', reviewer: true, suggestedSkills: ['review-checklist', 'ui-review'],
    requestedPermissions: readOnly,
    instructions: 'Review user interface changes. Check every state (empty, loading, error, long content), keyboard access and labels, light and dark themes, and narrow widths. Compare with the existing components and design tokens. Cite the file and line for each finding.' },
  'security-reviewer': { label: 'Reviewer bảo mật', description: 'Tìm lỗ hổng: input không tin cậy, đường dẫn, quyền, bí mật.', reviewer: true, suggestedSkills: ['review-checklist', 'security-review'],
    requestedPermissions: readOnly,
    instructions: 'Review the change for security defects: untrusted input reaching commands, paths or queries; path traversal and symlinks; permission checks; secrets in code or logs; unsafe defaults. Rate each finding by impact and cite the exact code. Do not report style issues.' },
  research: { label: 'Research (chỉ đọc)', description: 'Tìm hiểu và viết báo cáo; không sửa file, không chạy checks.', reviewer: true, suggestedSkills: [],
    requestedPermissions: { read: true, write: false, checks: false, gitCommit: false },
    instructions: 'Investigate the question by reading the project. Report findings with file references, open questions and a recommendation. Do not edit files.' },
} satisfies Record<string, ProfileTemplate>;
export type ProfileTemplateId = keyof typeof profileTemplates;
export const profileTemplateIds = Object.keys(profileTemplates) as ProfileTemplateId[];

/** A new draft from a template, pinning the suggested skills found in `catalog`. */
export function profileFromTemplate(template: ProfileTemplateId, profileId: string, name: string, catalog: Profile['skills'] = []): Profile {
  const source: ProfileTemplate = profileTemplates[template];
  const skills = source.suggestedSkills.flatMap(id => { const skill = catalog.find(item => item.id === id); return skill ? [{ id: skill.id, path: skill.path, sha256: skill.sha256 }] : []; });
  return { schemaVersion: 1, profileId, version: 1, name, instructions: source.instructions, skills, requestedPermissions: { ...source.requestedPermissions }, outputDefaults: {} };
}
