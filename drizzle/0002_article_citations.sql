CREATE TABLE "article_citations" (
	"citing_article_id" uuid NOT NULL,
	"cited_article_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_citations_citing_article_id_cited_article_id_pk" PRIMARY KEY("citing_article_id","cited_article_id"),
	CONSTRAINT "article_citations_not_self" CHECK ("article_citations"."citing_article_id" <> "article_citations"."cited_article_id")
);
--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_citing_article_id_articles_id_fk" FOREIGN KEY ("citing_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_cited_article_id_articles_id_fk" FOREIGN KEY ("cited_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_citations_cited_idx" ON "article_citations" USING btree ("cited_article_id");