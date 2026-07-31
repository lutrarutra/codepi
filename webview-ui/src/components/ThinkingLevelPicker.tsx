import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

interface Props {
	level: ThinkingLevel;
	onLevelChange: (level: ThinkingLevel) => void;
	disabled?: boolean;
	/** Whether the current model supports thinking. */
	supportsThinking?: boolean;
	/** Levels the current model actually supports (subset of ThinkingLevel). */
	supportedLevels?: ThinkingLevel[];
}

const levelConfig: Record<ThinkingLevel, { label: string; description: string }> = {
	off: { label: "Off", description: "No thinking/reasoning" },
	minimal: { label: "Minimal", description: "Very light reasoning" },
	low: { label: "Low", description: "Light reasoning effort" },
	medium: { label: "Medium", description: "Balanced reasoning" },
	high: { label: "High", description: "Deep reasoning effort" },
	xhigh: { label: "X-High", description: "Extra-high reasoning effort" },
	max: { label: "Max", description: "Maximum reasoning effort" },
};

/** Fallback for any level the SDK reports that we don't have a label for. */
const FALLBACK_CONFIG = { label: "Unknown", description: "" };

const levels: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function ThinkingLevelPicker({
	level,
	onLevelChange,
	disabled,
	supportsThinking = true,
	supportedLevels,
}: Props) {
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const ref = useRef<HTMLButtonElement>(null);

	// Model can't reason at all (or the SDK reports no non-off levels) — every
	// selection clamps to "off", so the selector must be disabled and show why.
	const canThink =
		supportsThinking && (supportedLevels ?? levels).some((l) => l !== "off");
	const options = supportedLevels ?? levels;
	const effective: ThinkingLevel = canThink ? level : "off";

	const openDropdown = useCallback(() => {
		if (disabled || !canThink) return;
		if (ref.current) setAnchor(ref.current.getBoundingClientRect());
		setOpen(true);
	}, [disabled, canThink]);

	const select = useCallback(
		(l: ThinkingLevel) => {
			onLevelChange(l);
			setOpen(false);
		},
		[onLevelChange],
	);

	const cfg = levelConfig[effective] ?? FALLBACK_CONFIG;

	return (
		<>
			<button
				ref={ref}
				className={`thinking-badge-btn ${canThink ? "" : "unsupported"}`}
				onClick={openDropdown}
				disabled={disabled || !canThink}
				title={
					canThink
						? `Thinking: ${cfg.label} — ${cfg.description}`
						: "This model does not support thinking/reasoning"
				}
			>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<polyline points="9 18 15 12 9 6"/>
				</svg>
				<span className="thinking-badge-name">{cfg.label}</span>
			</button>
			{open && (
				<ThinkingDropdown
					current={effective}
					options={options}
					onSelect={select}
					onClose={() => setOpen(false)}
					anchor={anchor}
				/>
			)}
		</>
	);
}

// ── Dropdown (portal) ─────────────────────────────────────

function ThinkingDropdown({
	current,
	options,
	onSelect,
	onClose,
	anchor,
}: {
	current: ThinkingLevel;
	options: ThinkingLevel[];
	onSelect: (level: ThinkingLevel) => void;
	onClose: () => void;
	anchor: DOMRect | null;
}) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		setTimeout(() => document.addEventListener("click", handler), 0);
		return () => document.removeEventListener("click", handler);
	}, [onClose]);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler as any);
		return () => window.removeEventListener("keydown", handler as any);
	}, [onClose]);

	if (!anchor) return null;

	const spaceAbove = anchor.top;
	const spaceBelow = window.innerHeight - anchor.bottom;
	const openUp = spaceAbove > spaceBelow;

	const style: React.CSSProperties = {
		position: "fixed",
		left: Math.max(8, Math.min(anchor.left, window.innerWidth - 220)),
		...(openUp
			? { bottom: window.innerHeight - anchor.top + 4 }
			: { top: anchor.bottom + 4 }),
		minWidth: 150,
		maxHeight: Math.min(300, (openUp ? spaceAbove : spaceBelow) - 8),
	};

	return createPortal(
		<div ref={ref} className="thinking-dropdown" style={style}>
			<div className="thinking-dropdown-header">Thinking Level</div>
			{options.map((l) => {
				const cfg = levelConfig[l] ?? FALLBACK_CONFIG;
				const isActive = l === current;
				return (
					<button
						key={l}
						className={`thinking-option-row ${isActive ? "active" : ""}`}
						onClick={() => onSelect(l)}
					>
						<span className="thinking-option-name">{cfg.label}</span>
						<span className="thinking-option-desc">{cfg.description}</span>
						{isActive && <span className="thinking-option-check">✓</span>}
					</button>
				);
			})}
			{options.length === 0 && (
				<div className="thinking-option-row thinking-option-empty">
					<span className="thinking-option-name">Not supported</span>
				</div>
			)}
		</div>,
		document.body,
	);
}
