"""Owner-selected model identities for this bounded experiment."""
APPROVED = frozenset({'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'openrouter/openrouter/free', 'zai/glm-5.3-flash'})


def live_model(model_id):
    if model_id not in APPROVED:
        raise ValueError('unapproved live model')
    if model_id == 'openrouter/openrouter/free':
        return {'providerID': 'openrouter', 'id': 'openrouter/free'}
    if model_id == 'zai/glm-5.3-flash':
        return {'providerID': 'zai', 'id': 'glm-5.3-flash', 'variant': 'high'}
    return {'providerID': 'opencode', 'id': model_id, 'variant': 'high'}
