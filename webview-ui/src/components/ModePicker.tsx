import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

type ChatMode = "ask" | "plan" | "agent";

interface Props {
	mode: ChatMode;
	onModeChange: (mode: ChatMode) => void;
	disabled?: boolean;
}

const modeConfig: Record<ChatMode, { label: string; description: string }> = {
	ask: { label: "Ask", description: "Read-only file browsing" },
	plan: { label: "Plan", description: "Read files, write .md plans" },
	agent: { label: "Agent", description: "Full read/write access" },
};

export function ModePicker({ mode, onModeChange, disabled }: Props) {
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const ref = useRef<HTMLButtonElement>(null);

	const openDropdown = useCallback(() => {
		if (disabled) return;
		if (ref.current) setAnchor(ref.current.getBoundingClientRect());
		setOpen(true);
	}, [disabled]);

	const selectMode = useCallback(
		(m: ChatMode) => {
			onModeChange(m);
			setOpen(false);
		},
		[onModeChange],
	);

	const cfg = modeConfig[mode];
	const shortName = cfg.label;

	return (
		<>
			<button
				ref={ref}
				className="mode-badge-btn"
				onClick={openDropdown}
				disabled={disabled}
				title={`${cfg.label} — ${cfg.description}`}
			>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="10"/>
				</svg>
				<span className="mode-badge-name">{shortName}</span>
			</button>
			{open && (
				<ModeDropdown
					currentMode={mode}
					onSelect={selectMode}
					onClose={() => setOpen(false)}
					anchor={anchor}
				/>
			)}
		</>
	);
}

// ── Mode dropdown (portal) ─────────────────────────────────

function ModeDropdown({
	currentMode,
	onSelect,
	onClose,
	anchor,
}: {
	currentMode: ChatMode;
	onSelect: (mode: ChatMode) => void;
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
		minWidth: 180,
		maxHeight: Math.min(300, (openUp ? spaceAbove : spaceBelow) - 8),
	};

	const modes: ChatMode[] = ["ask", "plan", "agent"];

	return createPortal(
		<div ref={ref} className="mode-dropdown" style={style}>
			<div className="mode-dropdown-header">Mode</div>
			{modes.map((m) => {
				const cfg = modeConfig[m];
				const isActive = m === currentMode;
				return (
					<button
						key={m}
						className={`mode-option-row ${isActive ? "active" : ""}`}
						onClick={() => onSelect(m)}
					>
						<span className="mode-option-name">{cfg.label}</span>
						<span className="mode-option-desc">{cfg.description}</span>
						{isActive && <span className="mode-option-check">✓</span>}
					</button>
				);
			})}
		</div>,
		document.body,
	);
}
