on run
	my launchRoni()
	quit
end run

on reopen
	my launchRoni()
	quit
end reopen

on launchRoni()
	set targetUrl to "https://web.telegram.org/k/#@sawyer_nc_bot"
	set targetBounds to {40, 70, 560, 900}
	if my focusChromeWindowForUrl(targetUrl, targetBounds) is false then
		do shell script "open -na '/Applications/Google Chrome.app' --args --profile-directory='Profile 1' --app=" & quoted form of targetUrl
		my waitForChromeWindow(targetUrl, targetBounds)
	end if
end launchRoni

on waitForChromeWindow(targetUrl, targetBounds)
	repeat 16 times
		delay 0.25
		if my focusChromeWindowForUrl(targetUrl, targetBounds) then return true
	end repeat
	return false
end waitForChromeWindow

on focusChromeWindowForUrl(targetUrl, targetBounds)
	try
		tell application "Google Chrome"
			repeat with chromeWindow in windows
				try
					if (URL of active tab of chromeWindow) starts with targetUrl then
						set bounds of chromeWindow to targetBounds
						set index of chromeWindow to 1
						activate
						return true
					end if
				end try
			end repeat
		end tell
	end try
	return false
end focusChromeWindowForUrl
