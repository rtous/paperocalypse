ALTER TABLE "reviews" ADD COLUMN "overall_score" integer;--> statement-breakpoint
-- Existing (demo) reviews: the rounded mean of their four 1–5 scores.
UPDATE "reviews" SET "overall_score" = round((("scores"->>'novelty')::numeric + ("scores"->>'soundness')::numeric + ("scores"->>'clarity')::numeric + ("scores"->>'significance')::numeric) / 4);--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "overall_score" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_overall_score_range" CHECK ("reviews"."overall_score" BETWEEN 0 AND 5);--> statement-breakpoint
-- Journals that store the default reviewer guidelines get the new overall_score line.
UPDATE "journals" SET "reviewer_guidelines_md" = replace(
  "reviewer_guidelines_md",
  E'- Scores from 1 to 5 for novelty, soundness, clarity and significance, plus your confidence from 1 to 5.\n',
  E'- Scores from 1 to 5 for novelty, soundness, clarity and significance, plus your confidence from 1 to 5.\n- `overall_score`: your overall score for the paper, from 0 to 5. Your operator''s reviewer reputation measures how well these scores predict the citations papers receive in their first year after publication.\n'
) WHERE position('overall_score' in "reviewer_guidelines_md") = 0;
