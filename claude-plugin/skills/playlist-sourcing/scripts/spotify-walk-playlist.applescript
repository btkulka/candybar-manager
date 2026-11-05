-- Walk a playlist in the signed-in Spotify desktop app and print one line per track.
--
--   osascript spotify-walk-playlist.applescript <playlistId> [maxTracks]
--
-- Output: one record per line, fields separated by ASCII 31 (unit separator):
--   spotify url | artist | name | album | duration ms | artwork url
-- Final line: "#wrapped=true" when the walk came back round to track 1 (the only
-- proof that the whole playlist was seen), otherwise "#wrapped=false".
--
-- The app is muted, set to repeat-context, walked, then put back: volume,
-- shuffle, repeat, the track that was playing and its position. The playback
-- context (which playlist/album it came from) cannot be restored by AppleScript.

on run argv
	if (count of argv) < 1 then error "usage: spotify-walk-playlist.applescript <playlistId> [maxTracks]"
	set playlistId to item 1 of argv
	set maxTracks to 1000
	if (count of argv) > 1 then set maxTracks to (item 2 of argv) as integer
	set LF to linefeed

	tell application "Spotify"
		-- Remember what was playing so it can be put back afterwards.
		set wasPlaying to (player state is playing)
		set origVolume to sound volume
		set origShuffle to shuffling
		set origRepeat to repeating
		set origUrl to ""
		set origPos to 0
		try
			set origUrl to spotify url of current track
			set origPos to player position
		end try

		-- Silent, in order, and REPEATING. With repeat off, Spotify's Autoplay
		-- carries on past the end into recommendations and the walk never comes
		-- back round, so a 40-track playlist reads as 500 tracks.
		set sound volume to 0
		set shuffling to false
		set repeating to true
		play track ("spotify:playlist:" & playlistId)
		delay 2
	end tell

	set outText to ""
	set firstUrl to ""
	set secondUrl to ""
	set wrapped to false
	set i to 0
	repeat while i < maxTracks
		set u to my trackUrl()
		if u is "" then exit repeat
		set rowText to my currentRow()
		if i > 0 and u is firstUrl then
			-- Back at track 1? A playlist can contain track 1 twice, so confirm
			-- by peeking at what follows: the real wrap is followed by track 2.
			if secondUrl is "" then
				set wrapped to true
				exit repeat
			end if
			my advance(u)
			if my trackUrl() is secondUrl then
				set wrapped to true
				exit repeat
			end if
			-- A mid-list duplicate of track 1: keep it, and the track after it
			-- is already loaded for the next pass.
			set outText to outText & rowText & LF
			set i to i + 1
		else
			set outText to outText & rowText & LF
			if i is 0 then set firstUrl to u
			if i is 1 then set secondUrl to u
			set i to i + 1
			my advance(u)
		end if
	end repeat

	tell application "Spotify"
		pause
		set repeating to origRepeat
		set shuffling to origShuffle
		if origUrl is not "" then
			try
				play track origUrl
				delay 0.5
				pause
				set player position to origPos
			end try
		end if
		set sound volume to origVolume
		if wasPlaying and origUrl is not "" then
			try
				play
			end try
		end if
	end tell

	return outText & "#wrapped=" & (wrapped as text)
end run

on trackUrl()
	tell application "Spotify"
		try
			return spotify url of current track
		on error
			return ""
		end try
	end tell
end trackUrl

on currentRow()
	set US to character id 31
	tell application "Spotify"
		set theTrack to current track
		set art to ""
		try
			set art to artwork url of theTrack
		end try
		return (spotify url of theTrack) & US & (artist of theTrack) & US & (name of theTrack) & US & (album of theTrack) & US & ((duration of theTrack) as text) & US & art
	end tell
end currentRow

-- Skip forward and wait until the app reports a different track (or give up
-- after ~4 s, which is what a one-track playlist looks like).
on advance(fromUrl)
	tell application "Spotify"
		next track
	end tell
	repeat with k from 1 to 16
		delay 0.25
		if my trackUrl() is not fromUrl then exit repeat
	end repeat
end advance
