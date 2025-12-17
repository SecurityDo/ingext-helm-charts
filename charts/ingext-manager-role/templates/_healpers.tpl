{{- define "mychart.serviceAccountName" -}}
{{- if .Values.serviceAccountName -}}
{{- .Values.serviceAccountName -}}
{{- else -}}
{{- printf "%s-sa" .Release.Namespace -}}
{{- end -}}
{{- end -}}
