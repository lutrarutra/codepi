import React from "react";
import type { SchemaField } from "../../../../src/shared/pi-settings-schema";
import type { SettingsRecord } from "../types";

interface Props {
	title: string;
	fields: SchemaField[];
	settings: SettingsRecord;
	onChange: (key: string, value: unknown) => void;
}

function stringify(v: unknown): string {
	return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2);
}

/** Renders one schema field into a control. */
export function FormSection({ title, fields, settings, onChange }: Props): JSX.Element {
	return (
		<section className="settings-section">
			<h3 className="settings-section-title">{title}</h3>
			{fields.map((field) => (
				<FieldRow key={field.key} field={field} settings={settings} onChange={onChange} />
			))}
		</section>
	);
}

function FieldRow({ field, settings, onChange }: { field: SchemaField; settings: SettingsRecord; onChange: (k: string, v: unknown) => void }): JSX.Element {
	const value = settings[field.key];
	return (
		<div className="settings-row">
			<label className="settings-label" htmlFor={`f-${field.key}`} title={field.help ?? ""}>
				{field.label}
			</label>
			<div className="settings-control">
				{field.type === "boolean" ? (
					<input
						id={`f-${field.key}`}
						type="checkbox"
						checked={value === true}
						onChange={(e) => onChange(field.key, e.target.checked || undefined)}
					/>
				) : field.type === "enum" ? (
					<select
						id={`f-${field.key}`}
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(field.key, e.target.value || undefined)}
					>
						<option value="">(default)</option>
						{(field.options ?? []).map((o) => (
							<option key={o} value={o}>{o}</option>
						))}
					</select>
				) : field.type === "string[]" ? (
					<input
						id={`f-${field.key}`}
						value={Array.isArray(value) ? value.join(", ") : ""}
						placeholder="comma-separated"
						onChange={(e) =>
							onChange(
								field.key,
								e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
							)
						}
					/>
				) : field.type === "object" ? (
					<textarea
						id={`f-${field.key}`}
						rows={3}
						value={stringify(value)}
						placeholder="{}"
						onChange={(e) => {
							const t = e.target.value.trim();
							if (!t) return onChange(field.key, undefined);
							try {
								onChange(field.key, JSON.parse(t));
							} catch {
								/* keep last valid value; validation will surface on save */
							}
						}}
					/>
				) : field.type === "number" ? (
					<input
						id={`f-${field.key}`}
						type="number"
						value={typeof value === "number" ? value : ""}
						onChange={(e) => {
							const n = e.target.value === "" ? undefined : Number(e.target.value);
							onChange(field.key, n);
						}}
					/>
				) : (
					<input
						id={`f-${field.key}`}
						type="text"
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(field.key, e.target.value || undefined)}
					/>
				)}
				{field.help ? <p className="settings-help">{field.help}</p> : null}
			</div>
		</div>
	);
}
