-- notch-cal.applescript — reads legacy Outlook's calendar and prints a
-- Worker-ready JSON body for PUT /api/events. Titles + times ONLY.
--
-- Why get occurrence: Outlook's AppleScript returns recurring series as a
-- single master dated at the series start. `get occurrence of m at <date>`
-- resolves one real instance (moved exceptions included) and errors when
-- there's no meeting that day, so each master is probed once per day.
--
-- usage: osascript notch-cal.applescript <days> <+HHMM tz offset>

on run argv
	set nDays to (item 1 of argv) as integer
	set tz to item 2 of argv -- e.g. "+0700"
	set tzIso to (text 1 thru 3 of tz) & ":" & (text 4 thru 5 of tz)

	set d0 to current date
	set hours of d0 to 0
	set minutes of d0 to 0
	set seconds of d0 to 0
	set dEnd to d0 + nDays * days

	set skipCals to {"United States holidays", "Birthdays", "Hari Libur Indonesia"}
	set seen to {}
	set items_ to {}

	tell application "Microsoft Outlook"
		repeat with c in calendars
			set cName to ""
			try
				set cName to name of c
			end try
			if cName is not missing value and skipCals does not contain cName then
				-- 1. one-off meetings (not series, not stored occurrence copies)
				try
					set oneOffs to (every calendar event of c whose start time ≥ d0 and start time < dEnd and is recurring is false and is occurrence is false)
				on error
					set oneOffs to {}
				end try
				repeat with e in oneOffs
					set end of items_ to {subject of e, start time of e, end time of e, all day flag of e, (free busy status of e) as string}
				end repeat
				-- 2. recurring series → one probe per day at the series' time of day
				try
					set seriesList to (every calendar event of c whose is recurring is true and start time < dEnd)
				on error
					set seriesList to {}
				end try
				repeat with m in seriesList
					set mStart to start time of m
					set tod to time of mStart
					repeat with k from 0 to (nDays - 1)
						try
							set o to get occurrence of m at (d0 + k * days + tod)
							set end of items_ to {subject of o, start time of o, end time of o, all day flag of o, (free busy status of o) as string}
						end try
					end repeat
				end repeat
			end if
		end repeat
	end tell

	set json to "["
	set first_ to true
	repeat with it_ in items_
		set t to item 1 of it_
		if t is missing value then set t to "(busy)"
		set s to item 2 of it_
		set e to item 3 of it_
		set allDay to item 4 of it_
		-- "free" = FYI broadcasts and calendars shared for info; they never block time
		set fb to item 5 of it_
		if s ≥ d0 and s < dEnd and not my isCanceled(t) and fb is not "free" then
			set key_ to t & "|" & (s as string)
			if seen does not contain key_ then
				set end of seen to key_
				if allDay then
					set sIso to my isoDate(s)
					set eIso to my isoDate(e)
				else
					set sIso to my isoDate(s) & "T" & my hms(s) & tzIso
					set eIso to my isoDate(e) & "T" & my hms(e) & tzIso
				end if
				if not first_ then set json to json & ","
				set first_ to false
				set json to json & "{\"title\":" & my jstr(t) & ",\"start\":\"" & sIso & "\",\"end\":\"" & eIso & "\",\"allDay\":" & (allDay as string) & "}"
			end if
		end if
	end repeat
	set json to json & "]"

	return "{\"from\":\"" & my isoDate(d0) & "\",\"to\":\"" & my isoDate(dEnd - 1) & "\",\"events\":" & json & "}"
end run

on isCanceled(t)
	repeat with p in {"Canceled:", "Cancelled:", "Dibatalkan:"}
		if t starts with p then return true
	end repeat
	return false
end isCanceled

on pad2(n)
	return text -2 thru -1 of ("0" & (n as integer))
end pad2

on isoDate(d)
	return ((year of d) as string) & "-" & my pad2((month of d) as integer) & "-" & my pad2(day of d)
end isoDate

on hms(d)
	return my pad2(hours of d) & ":" & my pad2(minutes of d) & ":00"
end hms

-- JSON string escaping: backslash, quote, and control characters.
on jstr(t)
	set out to ""
	repeat with ch in (characters of t)
		set ch to ch as string
		set cp to id of ch
		if ch is "\\" then
			set out to out & "\\\\"
		else if ch is "\"" then
			set out to out & "\\\""
		else if cp < 32 then
			set out to out & " "
		else
			set out to out & ch
		end if
	end repeat
	return "\"" & out & "\""
end jstr
