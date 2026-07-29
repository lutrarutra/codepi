import React from "react";

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	State
> {
	constructor(props: { children: React.ReactNode }) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error("[CodePi] React error boundary caught:", error, info);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="app-error">
					<p>An error occurred. Reload the window to continue.</p>
					<pre className="app-error-detail">
						{this.state.error?.message ?? "Unknown error"}
					</pre>
					<button
						className="app-error-reload"
						onClick={() => {
							this.setState({ hasError: false, error: null });
							window.location.reload();
						}}
					>
						Reload
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
