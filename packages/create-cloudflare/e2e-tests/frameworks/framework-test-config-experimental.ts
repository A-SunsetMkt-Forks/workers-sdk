import { keys, LONG_TIMEOUT } from "../helpers";

export default function getFrameworkTestConfigExperimental() {
	return {
		solid: {
			promptHandlers: [
				{
					matcher: /Which template would you like to use/,
					input: [keys.enter],
				},
			],
			flags: ["--ts"],
			testCommitMessage: true,
			timeout: LONG_TIMEOUT,
			unsupportedPms: ["npm", "yarn"],
			unsupportedOSs: ["win32"],
			verifyDeploy: {
				route: "/",
				expectedText: "Hello world",
			},
			verifyPreview: {
				route: "/",
				expectedText: "Hello world",
			},
			nodeCompat: true,
		},
	};
}
