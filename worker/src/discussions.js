// GitHub Discussions as the discussion backend, the office as the front.
// Everything runs with the signed-in person's own token, so visibility and authorship are GitHub's.
// Needs the GitHub App permission "Discussions: Read & write" and Discussions enabled on the data repo.
import { json } from "./util.js";

const apiBase = (env) => (env.GH_API_BASE || "https://api.github.com").replace(/\/$/, "");

async function gql(env, token, query, variables) {
  const r = await fetch(`${apiBase(env)}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "agent-office-worker" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`github graphql ${r.status}: ${data.message || ""}`);
  if (data.errors && data.errors.length) throw new Error(data.errors.map(e => e.message).join("; "));
  return data.data;
}
const split = (repo) => { const [owner, name] = repo.split("/"); return { owner, name }; };
const person = (a) => a ? { login: a.login, avatar: a.avatarUrl } : null;

export async function list(env, session, repo) {
  const q = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id hasDiscussionsEnabled
      discussionCategories(first:20){ nodes{ id name slug } }
      discussions(first:30, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ id number title url createdAt updatedAt bodyText
        author{ login avatarUrl } category{ name } comments{ totalCount } } } } }`;
  const d = await gql(env, session.gh, q, split(repo));
  const r = d.repository || {};
  return json({
    enabled: !!r.hasDiscussionsEnabled, repoId: r.id, url: `https://github.com/${repo}/discussions`,
    categories: ((r.discussionCategories || {}).nodes || []).map(c => ({ id: c.id, name: c.name, slug: c.slug })),
    discussions: ((r.discussions || {}).nodes || []).map(x => ({ id: x.id, number: x.number, title: x.title, url: x.url, createdAt: x.createdAt, updatedAt: x.updatedAt,
      excerpt: (x.bodyText || "").slice(0, 160), author: person(x.author), category: x.category && x.category.name, comments: (x.comments || {}).totalCount || 0 })),
  });
}

export async function one(env, session, repo, number) {
  const q = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ discussion(number:$number){
      id number title url bodyHTML createdAt updatedAt author{ login avatarUrl } category{ name }
      comments(first:60){ nodes{ id bodyHTML createdAt author{ login avatarUrl } replies(first:30){ nodes{ id bodyHTML createdAt author{ login avatarUrl } } } } } } } }`;
  const d = await gql(env, session.gh, q, { ...split(repo), number });
  const x = d.repository && d.repository.discussion;
  if (!x) return json({ error: "no such discussion" }, 404);
  const c = (n) => ({ id: n.id, html: n.bodyHTML, createdAt: n.createdAt, author: person(n.author) });
  return json({ id: x.id, number: x.number, title: x.title, url: x.url, html: x.bodyHTML, createdAt: x.createdAt, updatedAt: x.updatedAt, author: person(x.author), category: x.category && x.category.name,
    comments: ((x.comments || {}).nodes || []).map(n => ({ ...c(n), replies: ((n.replies || {}).nodes || []).map(c) })) });
}

export async function create(env, session, repo, body) {
  if (!body || !body.title || !body.body) return json({ error: "title and body required" }, 400);
  const meta = await gql(env, session.gh, `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id discussionCategories(first:20){ nodes{ id name slug } } } }`, split(repo));
  const r = meta.repository; if (!r) return json({ error: "no such repo" }, 404);
  const cats = (r.discussionCategories || {}).nodes || [];
  const cat = cats.find(c => c.id === body.categoryId) || cats.find(c => /general|일반/i.test(c.name)) || cats[0];
  if (!cat) return json({ error: "Discussions is not enabled on this repository" }, 409);
  const d = await gql(env, session.gh, `mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){ createDiscussion(input:{repositoryId:$repo, categoryId:$cat, title:$title, body:$body}){ discussion{ number url } } }`,
    { repo: r.id, cat: cat.id, title: String(body.title).slice(0, 200), body: String(body.body).slice(0, 60000) });
  return json({ ok: true, ...d.createDiscussion.discussion });
}

export async function comment(env, session, repo, number, body) {
  if (!body || !body.body) return json({ error: "body required" }, 400);
  const d0 = await gql(env, session.gh, `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ discussion(number:$number){ id } } }`, { ...split(repo), number });
  const id = d0.repository && d0.repository.discussion && d0.repository.discussion.id;
  if (!id) return json({ error: "no such discussion" }, 404);
  const d = await gql(env, session.gh, `mutation($id:ID!,$body:String!,$reply:ID){ addDiscussionComment(input:{discussionId:$id, body:$body, replyToId:$reply}){ comment{ id url } } }`,
    { id, body: String(body.body).slice(0, 60000), reply: body.replyToId || null });
  return json({ ok: true, ...d.addDiscussionComment.comment });
}
