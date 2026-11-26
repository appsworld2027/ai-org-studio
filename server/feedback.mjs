// Feedback & Correction Workflow — Studio ↔ AI Org integration
// Pure logic + GitHub API calls for the founder review inbox and correction tracking

import { ghJson, run } from "./utils.mjs";

export const FEEDBACK_STATES = {
  DELIVERED: "delivered",           // ai:delivery label present
  FEEDBACK_GIVEN: "feedback_given", // founder posted /changes or /discuss
  FIX_IN_PROGRESS: "fix_in_progress", // ai:fix issue exists, Dev working
  QA_IN_PROGRESS: "qa_in_progress",   // ai:qa label, Quinn testing
  REVIEW_IN_PROGRESS: "review_in_progress", // ai:review label, Rex reviewing
  READY_FOR_TEST: "ready_for_test",   // ai:founder-test PR open, preview available
  ACCEPTED: "accepted",               // founder posted /approve
  SHIPPED: "shipped",                 // merged to main
  BLOCKED: "blocked",                 // ai:blocked label
};

function slugOf(title = "") {
  return (title.match(/\[([a-z0-9-]+)\]\s*$/) || title.match(/^ai\/(?:contract|build|fix)-([a-z0-9-]+?)(?:-\d+)?$/) || [])[1] || null;
}

async function getRepoData(p) {
  const R = `repos/${p.repo}`;
  const [issues, pulls, comments] = await Promise.all([
    ghJson(`${R}/issues?state=open&per_page=100&labels=ai:delivery`),
    ghJson(`${R}/pulls?state=open&per_page=100`),
    ghJson(`${R}/issues/comments?sort=created&direction=desc&per_page=100`),
  ]);
  return { issues, pulls, comments };
}

function parseFounderCommand(body = "") {
  const trimmed = body.trim();
  if (/^\/approve\b/i.test(trimmed)) return { type: "approve", text: trimmed.replace(/^\/approve\b/i, "").trim() };
  if (/^\/changes\b/i.test(trimmed)) return { type: "changes", text: trimmed.replace(/^\/changes\b/i, "").trim() };
  if (/^\/discuss\b/i.test(trimmed)) return { type: "discuss", text: trimmed.replace(/^\/discuss\b/i, "").trim() };
  if (/^\/next\b/i.test(trimmed)) return { type: "next", text: trimmed.replace(/^\/next\b/i, "").trim() };
  if (/^\/stop\b/i.test(trimmed)) return { type: "stop", text: trimmed.replace(/^\/stop\b/i, "").trim() };
  return null;
}

function findPreviewUrl(pulls, branch) {
  // Look for deployment status on the PR's head commit
  // This is a simplified version; real implementation checks deployments API
  return null; // Will be populated from board data
}

function getQASummary(comments, issueNumber) {
  const qaComments = comments.filter(c => {
    const body = c.body || "";
    return c.issue_url?.includes(`/issues/${issueNumber}`) &&
           (body.includes("QA") || body.includes("Quinn") || body.includes("ai-org:qa"));
  });
  if (!qaComments.length) return { status: "unknown", summary: "No QA evidence yet", details: [] };
  const latest = qaComments[0];
  const passed = (latest.body.match(/passed[:\s]+(\d+)/i) || [])[1];
  const failed = (latest.body.match(/failed[:\s]+(\d+)/i) || [])[1];
  return {
    status: failed && +failed > 0 ? "failed" : passed ? "passed" : "unknown",
    summary: latest.body.slice(0, 200),
    details: qaComments.map(c => ({ at: c.created_at, by: c.user?.login, text: c.body.slice(0, 300) }))
  };
}

function getReviewVerdict(comments, issueNumber) {
  const reviewComments = comments.filter(c => {
    const body = c.body || "";
    return c.issue_url?.includes(`/issues/${issueNumber}`) &&
           (body.includes("Verdict") || body.includes("Rex") || body.includes("ai-org:review"));
  });
  if (!reviewComments.length) return { verdict: "pending", summary: "No review yet" };
  const latest = reviewComments[0];
  const verdict = latest.body.includes("APPROVE") ? "approve" :
                  latest.body.includes("REQUEST_CHANGES") ? "request_changes" : "comment";
  return { verdict, summary: latest.body.slice(0, 200), at: latest.created_at, by: latest.user?.login };
}

export async function feedbackInbox(p) {
  const { issues, comments } = await getRepoData(p);
  const inbox = [];
  
  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name);
    const slug = slugOf(issue.title);
    const isPR = !!issue.pull_request;
    const previewUrl = isPR ? `https://github.com/${p.repo}/pull/${issue.number}` : null;
    
    // Get QA and review evidence from comments
    const qa = getQASummary(comments, issue.number);
    const review = getReviewVerdict(comments, issue.number);
    
    // Check for founder feedback already given
    const founderFeedback = comments.find(c => 
      c.issue_url?.includes(`/issues/${issue.number}`) &&
      parseFounderCommand(c.body)
    );
    
    inbox.push({
      id: issue.number,
      title: issue.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
      slug,
      state: founderFeedback ? FEEDBACK_STATES.FEEDBACK_GIVEN : FEEDBACK_STATES.DELIVERED,
      previewUrl,
      qa,
      review,
      founderFeedback: founderFeedback ? { type: parseFounderCommand(founderFeedback.body).type, text: parseFounderCommand(founderFeedback.body).text, at: founderFeedback.created_at } : null,
      labels,
      updatedAt: issue.updated_at,
      url: issue.html_url,
    });
  }
  
  return { inbox, count: inbox.length };
}

export async function feedbackDeliveries(p) {
  const { issues, pulls, comments } = await getRepoData(p);
  const allDeliveries = [];
  
  // Issues with ai:delivery label
  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name);
    const slug = slugOf(issue.title);
    const qa = getQASummary(comments, issue.number);
    const review = getReviewVerdict(comments, issue.number);
    const founderFeedback = comments.find(c => 
      c.issue_url?.includes(`/issues/${issue.number}`) &&
      parseFounderCommand(c.body)
    );
    
    allDeliveries.push({
      id: issue.number,
      title: issue.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
      slug,
      type: "issue",
      state: founderFeedback ? FEEDBACK_STATES.FEEDBACK_GIVEN : FEEDBACK_STATES.DELIVERED,
      previewUrl: null,
      qa,
      review,
      founderFeedback: founderFeedback ? { type: parseFounderCommand(founderFeedback.body).type, text: parseFounderCommand(founderFeedback.body).text, at: founderFeedback.created_at } : null,
      labels,
      updatedAt: issue.updated_at,
      url: issue.html_url,
    });
  }
  
  // PRs with ai:founder-test label (ready for test)
  const testPRs = pulls.filter(pr => pr.labels.some(l => l.name === "ai:founder-test"));
  for (const pr of testPRs) {
    const labels = pr.labels.map(l => l.name);
    const slug = slugOf(pr.title);
    const qa = getQASummary(comments, pr.number);
    const review = getReviewVerdict(comments, pr.number);
    
    allDeliveries.push({
      id: pr.number,
      title: pr.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
      slug,
      type: "pr",
      state: FEEDBACK_STATES.READY_FOR_TEST,
      previewUrl: `https://github.com/${p.repo}/pull/${pr.number}`,
      qa,
      review,
      founderFeedback: null,
      labels,
      updatedAt: pr.updated_at,
      url: pr.html_url,
    });
  }
  
  return { deliveries: allDeliveries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) };
}

export async function feedbackDeliveryDetail(p, number) {
  const R = `repos/${p.repo}`;
  const [issue, comments] = await Promise.all([
    ghJson(`${R}/issues/${number}`),
    ghJson(`${R}/issues/${number}/comments?sort=created&direction=asc&per_page=100`),
  ]);
  
  if (!issue) return { error: "Not found" };
  
  const labels = issue.labels.map(l => l.name);
  const slug = slugOf(issue.title);
  const qa = getQASummary(comments, number);
  const review = getReviewVerdict(comments, number);
  
  const feedbackComments = comments.filter(c => parseFounderCommand(c.body));
  const fixComments = comments.filter(c => c.body.includes("ai-org:fix") || c.body.includes("ai:fix"));
  
  return {
    id: issue.number,
    title: issue.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
    slug,
    body: issue.body,
    state: labels.includes("ai:founder-test") ? FEEDBACK_STATES.READY_FOR_TEST :
           labels.includes("ai:blocked") ? FEEDBACK_STATES.BLOCKED :
           feedbackComments.length ? FEEDBACK_STATES.FEEDBACK_GIVEN : FEEDBACK_STATES.DELIVERED,
    labels,
    qa,
    review,
    feedbackHistory: feedbackComments.map(c => ({ 
      type: parseFounderCommand(c.body).type, 
      text: parseFounderCommand(c.body).text, 
      at: c.created_at, 
      by: c.user?.login,
      raw: c.body 
    })),
    fixHistory: fixComments.map(c => ({ text: c.body.slice(0, 500), at: c.created_at, by: c.user?.login })),
    allComments: comments.map(c => ({ body: c.body, at: c.created_at, by: c.user?.login })),
    url: issue.html_url,
  };
}

export async function feedbackSubmit(p, { deliveryId, type, text, attachments = [] }) {
  const R = `repos/${p.repo}`;
  
  // Validate command type
  if (!["approve", "changes", "discuss"].includes(type)) {
    return { error: "Invalid feedback type. Use approve, changes, or discuss." };
  }
  
  // Post comment as founder (using gh CLI which uses founder's auth)
  const command = `/${type} ${text || ""}`.trim();
  try {
    await run("gh", ["issue", "comment", String(deliveryId), "--body", command, "--repo", p.repo]);
  } catch (e) {
    return { error: `Failed to post feedback: ${e.message}` };
  }
  
  // If changes/discuss, also trigger Maya to create ai:fix issue
  if (["changes", "discuss"].includes(type)) {
    // Get delivery details to extract slug
    const delivery = await feedbackDeliveryDetail(p, deliveryId);
    if (delivery.slug) {
      // Create ai:fix issue via Maya (this would be done by the AI Org loop)
      // For now, we return info for the founder to know what happens next
      return { 
        ok: true, 
        message: "Feedback posted. Maya will create an ai:fix issue with your feedback.",
        nextStep: "Maya interprets feedback → creates structured fix task → assigns Dev",
        slug: delivery.slug
      };
    }
  }
  
  if (type === "approve") {
    return { ok: true, message: "Approved! Feature will be merged to main.", nextStep: "Sam merges to main → shipped" };
  }
  
  return { ok: true };
}

export async function feedbackFixes(p) {
  const R = `repos/${p.repo}`;
  const issues = await ghJson(`${R}/issues?state=open&per_page=50&labels=ai:fix`);
  const fixes = [];
  
  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name);
    const slug = slugOf(issue.title);
    const comments = await ghJson(`${R}/issues/${issue.number}/comments?sort=created&direction=desc&per_page=20`);
    
    // Find the original feedback that triggered this fix
    const feedbackComment = comments.find(c => c.body.includes("ai-org:feedback"));
    // Find Maya's task breakdown
    const taskComment = comments.find(c => c.body.includes("ai-org:task"));
    // Find Dev's progress
    const devComments = comments.filter(c => c.body.includes("Dev:") || c.body.includes("ai-org:dev"));
    // Find Quinn's test results
    const qaComments = comments.filter(c => c.body.includes("Quinn:") || c.body.includes("ai-org:qa"));
    // Find Rex's review
    const reviewComments = comments.filter(c => c.body.includes("Rex:") || c.body.includes("ai-org:review"));
    
    let state = FEEDBACK_STATES.FIX_IN_PROGRESS;
    if (labels.includes("ai:qa")) state = FEEDBACK_STATES.QA_IN_PROGRESS;
    else if (labels.includes("ai:review")) state = FEEDBACK_STATES.REVIEW_IN_PROGRESS;
    else if (labels.includes("ai:founder-test")) state = FEEDBACK_STATES.READY_FOR_TEST;
    else if (labels.includes("ai:blocked")) state = FEEDBACK_STATES.BLOCKED;
    
    fixes.push({
      id: issue.number,
      title: issue.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
      slug,
      state,
      labels,
      feedback: feedbackComment ? { text: feedbackComment.body.slice(0, 300), at: feedbackComment.created_at } : null,
      task: taskComment ? { text: taskComment.body.slice(0, 500), at: taskComment.created_at } : null,
      devProgress: devComments.slice(0, 3).map(c => ({ text: c.body.slice(0, 300), at: c.created_at })),
      qaResults: qaComments.slice(0, 3).map(c => ({ text: c.body.slice(0, 300), at: c.created_at })),
      review: reviewComments[0] ? { text: reviewComments[0].body.slice(0, 300), at: reviewComments[0].created_at } : null,
      updatedAt: issue.updated_at,
      url: issue.html_url,
    });
  }
  
  return { fixes: fixes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) };
}

export async function feedbackFixDetail(p, number) {
  const R = `repos/${p.repo}`;
  const [issue, comments] = await Promise.all([
    ghJson(`${R}/issues/${number}`),
    ghJson(`${R}/issues/${number}/comments?sort=created&direction=asc&per_page=100`),
  ]);
  
  if (!issue) return { error: "Not found" };
  
  const labels = issue.labels.map(l => l.name);
  const slug = slugOf(issue.title);
  
  const feedbackComment = comments.find(c => c.body.includes("ai-org:feedback"));
  const taskComment = comments.find(c => c.body.includes("ai-org:task"));
  const devComments = comments.filter(c => c.body.includes("Dev:") || c.body.includes("ai-org:dev"));
  const qaComments = comments.filter(c => c.body.includes("Quinn:") || c.body.includes("ai-org:qa"));
  const reviewComments = comments.filter(c => c.body.includes("Rex:") || c.body.includes("ai-org:review"));
  
  let state = FEEDBACK_STATES.FIX_IN_PROGRESS;
  if (labels.includes("ai:qa")) state = FEEDBACK_STATES.QA_IN_PROGRESS;
  else if (labels.includes("ai:review")) state = FEEDBACK_STATES.REVIEW_IN_PROGRESS;
  else if (labels.includes("ai:founder-test")) state = FEEDBACK_STATES.READY_FOR_TEST;
  else if (labels.includes("ai:blocked")) state = FEEDBACK_STATES.BLOCKED;
  
  return {
    id: issue.number,
    title: issue.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""),
    slug,
    body: issue.body,
    state,
    labels,
    feedback: feedbackComment ? { raw: feedbackComment.body, at: feedbackComment.created_at } : null,
    task: taskComment ? { raw: taskComment.body, at: taskComment.created_at } : null,
    devProgress: devComments.map(c => ({ raw: c.body, at: c.created_at })),
    qaResults: qaComments.map(c => ({ raw: c.body, at: c.created_at })),
    review: reviewComments.map(c => ({ raw: c.body, at: c.created_at })),
    allComments: comments.map(c => ({ body: c.body, at: c.created_at, by: c.user?.login })),
    url: issue.html_url,
  };
}

export async function feedbackConflicts(p) {
  // Detect contradictory feedback across sessions
  // This is a placeholder - real implementation would analyze feedback history
  const R = `repos/${p.repo}`;
  const issues = await ghJson(`${R}/issues?state=all&per_page=100&labels=ai:fix`);
  
  const conflicts = [];
  for (const issue of issues) {
    const comments = await ghJson(`${R}/issues/${issue.number}/comments?per_page=50`);
    const feedbacks = comments
      .filter(c => parseFounderCommand(c.body))
      .map(c => ({ type: parseFounderCommand(c.body).type, text: parseFounderCommand(c.body).text, at: c.created_at }));
    
    // Simple conflict detection: multiple /changes with contradictory keywords
    const changes = feedbacks.filter(f => f.type === "changes");
    if (changes.length > 1) {
      const texts = changes.map(c => c.text.toLowerCase());
      const hasContradiction = texts.some((t, i) => 
        texts.slice(i+1).some(other => 
          (t.includes("red") && other.includes("blue")) ||
          (t.includes("show") && other.includes("hide")) ||
          (t.includes("add") && other.includes("remove")) ||
          (t.includes("enable") && other.includes("disable"))
        )
      );
      if (hasContradiction) {
        conflicts.push({
          fixId: issue.number,
          title: issue.title,
          slug: slugOf(issue.title),
          feedbacks: changes,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }
  
  return { conflicts };
}

export async function feedbackUsage(p) {
  // Model usage per agent for feedback workflow
  // This would integrate with usage.mjs ledger
  return { 
    note: "Model usage tracking integrated with Studio's usage ledger. See /api/products/:id/usage",
    agents: [
      { name: "Maya", role: "Feedback interpretation", model: "TBD", tokensIn: 0, tokensOut: 0, cost: 0 },
      { name: "Dev", role: "Fix implementation", model: "TBD", tokensIn: 0, tokensOut: 0, cost: 0 },
      { name: "Quinn", role: "QA verification", model: "TBD", tokensIn: 0, tokensOut: 0, cost: 0 },
      { name: "Rex", role: "Code review", model: "TBD", tokensIn: 0, tokensOut: 0, cost: 0 },
    ]
  };
}