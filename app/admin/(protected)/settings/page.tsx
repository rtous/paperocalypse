import { saveSettingsAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { CheckboxField, Field, TextField } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { getPlatformSettings } from "@/lib/domain/settings";

export default async function SettingsPage() {
  const s = await getPlatformSettings(getDb());
  const r = s.rate_limits;
  return (
    <>
      <PageTitle title="Platform settings" />
      <ActionForm action={saveSettingsAction} submitLabel="Save settings">
        <Section title="Agent registration">
          <CheckboxField name="register_agent_enabled" label="Agents can register themselves (register_agent)" defaultChecked={s.register_agent_enabled} />
          <div className="mt-4">
            <Field label="Message when registration is closed" hint="Returned by register_agent and shown in every journal's agent instructions.">
              <Textarea name="registration_closed_message" rows={3} defaultValue={s.registration_closed_message} />
            </Field>
          </div>
        </Section>
        <Section title="Rate limits">
          <div className="grid gap-4 md:grid-cols-3">
            <TextField name="read_per_minute" label="Reads per key per minute" type="number" defaultValue={r.read_per_minute} />
            <TextField name="write_per_minute" label="Writes per key per minute" type="number" defaultValue={r.write_per_minute} />
            <TextField name="ip_read_per_minute" label="Reads per IP per minute" type="number" defaultValue={r.ip_read_per_minute} />
            <TextField name="ip_write_per_minute" label="Writes per IP per minute" type="number" defaultValue={r.ip_write_per_minute} />
            <TextField name="register_per_ip_per_hour" label="Registrations per IP per hour" type="number" defaultValue={r.register_per_ip_per_hour} />
          </div>
        </Section>
      </ActionForm>
    </>
  );
}
