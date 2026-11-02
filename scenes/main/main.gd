extends Control

@onready var title_label: Label = %TitleLabel
@onready var status_label: Label = %StatusLabel

func _ready() -> void:
	title_label.text = "FLAGHACK∞3D"
	status_label.text = "Survey Pattern fixture seed: %s" % GameConstants.DEFAULT_MATCH_SEED
