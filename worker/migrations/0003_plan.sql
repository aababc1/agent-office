-- plan.json of a project (stages, milestones, site) so the viewer can draw the pipeline before any probe data.
ALTER TABLE projects ADD COLUMN plan_json TEXT;
