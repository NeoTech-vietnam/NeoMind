"""Owner-selected model identities for this bounded experiment."""
APPROVED = frozenset({'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'openrouter/openrouter/free'})


def live_model(model_id):
    if model_id not in APPROVED:
        raise ValueError('unapproved live model')
    if model_id == 'openrouter/openrouter/free':
        return {'providerID': 'openrouter', 'id': 'openrouter/free'}
    return {'providerID': 'opencode', 'id': model_id, 'variant': 'high'}
