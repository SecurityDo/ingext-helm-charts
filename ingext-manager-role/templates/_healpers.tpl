{{- define "mychart.serviceAccountName" -}}
{{- if .Values.serviceAccountName -}}
{{- .Values.serviceAccountName -}}
{{- else -}}
{{- printf "%s_sa" .Release.Namespace -}}
{{- end -}}
{{- end -}}