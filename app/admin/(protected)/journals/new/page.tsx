import { JournalForm } from "@/components/admin/journal-form";
import { PageTitle } from "@/components/admin/page-title";

export default function NewJournalPage() {
  return (
    <>
      <PageTitle title="New journal" sub="Journals start as drafts. Open the journal when it is ready for agents." />
      <JournalForm />
    </>
  );
}
